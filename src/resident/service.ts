import { normalizeError } from "../errors"
import { RunPeers, serveRunSocket } from "../worker-identity/peer"
import { WorkerIdentity } from "../worker-identity/service"
import { Context, Effect, Layer, Option, Queue, Schedule, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CiService } from "../ci/service"
import { EventSelector, makeSubscriptions } from "./subscriptions"
import type { CiConfig } from "../ci/config"
import { AgentRunStore } from "../kernel/agent-run-store"
import { makeEventQueue, type CodexCliPort, type CodexExit } from "../kernel/codex-session"
import { WorkspaceError } from "../workspace/errors"
import { makeResidentStore } from "./store"
import { startAppServer } from "./process"
import { deliverResident } from "./delivery"
import type { ResidentConfig } from "./config"
import { ExecutionSelectionError } from "../execution-selection"

const ThreadResult = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.optionalKey(Schema.String),
  modelProvider: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const TurnEvent = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({ id: Schema.String, status: Schema.String }),
})
const ItemEvent = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
})
const Subscribe = Schema.Struct({ runId: Schema.NonEmptyString, selector: EventSelector })
const Queued = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  nextCursor: Schema.NullOr(Schema.String),
})
const History = Schema.Struct({
  thread: Schema.Struct({
    turns: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  }),
})
type ResidentPort = {
  readonly cli: CodexCliPort
  readonly route: (request: Request, peerPid?: number) => Effect.Effect<Response | undefined>
}
export const ResidentCodex = Context.Service<ResidentPort>("workflowd/ResidentCodex")

export const ResidentCodexLive = (
  config: ResidentConfig,
  binary: string,
  ciConfig: CiConfig,
  start: typeof startAppServer = startAppServer,
) =>
  Layer.effect(
    ResidentCodex,
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      const runs = yield* AgentRunStore
      const ci = yield* CiService
      const sql = yield* SqlClient.SqlClient
      const notifications = yield* Queue.unbounded<{
        readonly method: string
        readonly params: unknown
      }>()
      const identity = yield* Effect.serviceOption(WorkerIdentity)
      const peers = new RunPeers()
      const servers = new Map<
        string,
        {
          process: ReturnType<typeof startAppServer>
          disconnected: boolean
          attempts: number
          lastEventAt: number
        }
      >()
      const threadRuns = new Map<string, string>()
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(async () => {
          await Promise.all([...servers.values()].map((entry) => entry.process.close()))
        }).pipe(Effect.orDie),
      )
      const launch = Effect.fn("Resident.launch")(function* (runId: string, attempts: number = 0) {
        const env = {
          ...(Option.isSome(identity) ? identity.value.environment(runId) : {}),
          WORKFLOWD_RUN_ID: runId,
          WORKFLOWD_CODEX_RESIDENT_SOCKET: config.socket,
        }
        const process = yield* Effect.try(() =>
          start({ binary, home: config.home, env }, (frame) => {
            const current = servers.get(runId)
            if (current !== undefined) current.lastEventAt = Date.now()
            if (frame.method === "workflowd/disconnected") {
              const entry = servers.get(runId)
              if (entry !== undefined) entry.disconnected = true
            }
            Queue.offerUnsafe(notifications, frame)
          }),
        )
        servers.set(runId, { process, disconnected: false, attempts, lastEventAt: Date.now() })
        yield* Effect.try(() => {
          peers.register(runId, process.pid)
          if (Option.isSome(identity)) identity.value.register(runId, process.pid)
        })
        yield* Effect.tryPromise(() => process.initialize())
        return process
      })
      const listeners = new Map<
        string,
        { queue: ReturnType<typeof makeEventQueue>; finish: (exit: CodexExit) => void }
      >()
      const request = (method: string, params: { threadId: string; [key: string]: unknown }) => {
        const runId = threadRuns.get(params.threadId)
        const entry = runId === undefined ? undefined : servers.get(runId)
        if (entry === undefined)
          return Promise.reject(new Error("Resident run process unavailable"))
        return entry.process.rpc.request(method, params)
      }
      const finish = Effect.fn("Resident.finish")(function* (threadId: string, failed: boolean) {
        const row = yield* store.read(threadId)
        const listener = listeners.get(threadId)
        if (row !== null) {
          peers.revoke(row.run_id)
          const entry = servers.get(row.run_id)
          servers.delete(row.run_id)
          threadRuns.delete(threadId)
          if (entry !== undefined) yield* Effect.tryPromise(() => entry.process.close())
          const run = yield* runs.read(row.run_id)
          if (run?.state === "verified") {
            yield* failed
              ? runs.operatorRequired({
                  runId: row.run_id,
                  diagnostic: "resident_turn_failed",
                  now: new Date(),
                })
              : runs.complete({ runId: row.run_id, now: new Date() })
          }
        }
        listener?.queue.close()
        listener?.finish({ exitCode: failed ? 1 : 0, stderr: "" })
        listeners.delete(threadId)
      })
      const deliveryLock = yield* Semaphore.make(1)
      const completeTurn = Effect.fn("Resident.completeTurn")(function* (
        event: typeof TurnEvent.Type,
      ) {
        const queued = yield* Effect.tryPromise(() =>
          request("thread/queue/list", { threadId: event.threadId, cursor: null, limit: 1 }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Queued)))
        let queuedWork = queued.data.length > 0 || queued.nextCursor !== null
        if (!queuedWork) {
          // The next submission may have left the queue before its started notification is handled.
          const history = yield* Effect.tryPromise(() =>
            request("thread/read", { threadId: event.threadId, includeTurns: true }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(History)))
          const last = history.thread.turns.at(-1)
          queuedWork =
            last !== undefined && last.id !== event.turn.id && last.status === "inProgress"
        }
        const state = yield* store.completed(event.threadId, event.turn.id, queuedWork)
        if (state === "finished" || event.turn.status === "failed")
          yield* finish(event.threadId, event.turn.status !== "completed")
      })
      const handle = Effect.fn("Resident.notification")(function* (frame: {
        readonly method: string
        readonly params: unknown
      }) {
        if (frame.method === "turn/started") {
          const event = yield* Schema.decodeUnknownEffect(TurnEvent)(frame.params)
          yield* store.started(event.threadId, event.turn.id)
          listeners.get(event.threadId)?.queue.push({ type: "turn.started" })
        } else if (frame.method === "item/completed") {
          const event = yield* Schema.decodeUnknownEffect(ItemEvent)(frame.params)
          if (event.item.type === "agentMessage" && event.item.text !== undefined)
            listeners
              .get(event.threadId)
              ?.queue.push({ type: "agent_message", text: event.item.text })
        } else if (frame.method === "turn/completed") {
          const event = yield* Schema.decodeUnknownEffect(TurnEvent)(frame.params)
          yield* Semaphore.withPermits(deliveryLock, 1)(completeTurn(event))
        }
      })
      yield* Effect.forever(
        Queue.take(notifications).pipe(
          Effect.flatMap(handle),
          Effect.catch(() => Effect.logWarning("Resident notification rejected")),
        ),
      ).pipe(Effect.forkScoped)

      const hasCustody = Effect.fn("Resident.hasCustody")(function* (threadId: string) {
        const rows = yield* sql`SELECT s.session_id FROM resident_threads t
          JOIN kernel_agent_runs a ON a.run_id = t.run_id AND a.native_session_id = t.thread_id AND a.directory = t.directory
          JOIN kernel_sessions s ON s.session_id = a.session_id AND s.native_session_id = t.thread_id
          JOIN kernel_working_resources r ON r.resource_id = s.resource_id AND r.absolute_path = t.directory
          WHERE t.thread_id = ${threadId} AND a.state = 'verified' AND s.provider_kind = 'codex'
            AND s.state IN ('ready','active') AND r.state = 'reserved'`
        return rows.length === 1
      })
      const restoreCustody = Effect.fn("Resident.restoreCustody")(function* (
        row: typeof import("./store").ResidentThread.Type,
      ) {
        const run = yield* runs.read(row.run_id)
        if (yield* hasCustody(row.thread_id)) return true
        yield* store.uncertain(`restore:${row.thread_id}`, row.thread_id)
        yield* finish(row.thread_id, true)
        if (run !== null && ["accepted", "spawning", "spawned"].includes(run.state))
          yield* runs.operatorRequired({
            runId: row.run_id,
            diagnostic: "resident_dispatch_incomplete",
            now: new Date(),
          })
        return false
      })
      const restore = Effect.fn("Resident.restore")(function* (onlyThread?: string) {
        for (const row of yield* store.threads()) {
          if (onlyThread !== undefined && row.thread_id !== onlyThread) continue
          threadRuns.set(row.thread_id, row.run_id)
          if (!(yield* restoreCustody(row))) continue
          if (!servers.has(row.run_id)) yield* launch(row.run_id)
          const accepted = yield* runs.read(row.run_id)
          const selection = accepted?.resolvedSelection
          const resumed = yield* Effect.tryPromise(() =>
            request("thread/resume", {
              threadId: row.thread_id,
              cwd: row.directory,
              model: selection?.model ?? row.model,
              ...(selection?.provider == null ? {} : { modelProvider: selection.provider }),
              ...(selection?.thinking.effort === undefined
                ? {}
                : { config: { model_reasoning_effort: selection.thinking.effort } }),
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            }),
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  model: Schema.optionalKey(Schema.String),
                  modelProvider: Schema.optionalKey(Schema.String),
                  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
                }),
              ),
            ),
          )
          if (
            selection != null &&
            ((selection.thinking.effort !== undefined &&
              resumed.reasoningEffort !== selection.thinking.effort) ||
              (selection.model !== null && resumed.model !== selection.model) ||
              (selection.provider !== null && resumed.modelProvider !== selection.provider))
          ) {
            yield* store.uncertain(`selection:${row.thread_id}`, row.thread_id)
            yield* runs.operatorRequired({
              runId: row.run_id,
              diagnostic:
                "resident_selection_mismatch: native resume did not confirm the accepted selection",
              now: new Date(),
            })
            yield* finish(row.thread_id, true)
            continue
          }
          const history = yield* Effect.tryPromise(() =>
            request("thread/read", { threadId: row.thread_id, includeTurns: true }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(History)))
          const last = history.thread.turns.at(-1)
          if (last !== undefined && last.id !== row.current_turn)
            yield* store.started(row.thread_id, last.id)
          if (last?.status === "completed")
            yield* handle({
              method: "turn/completed",
              params: { threadId: row.thread_id, turn: last },
            })
          else if (last !== undefined && last.id !== row.wait_turn)
            yield* store.enqueue(
              `restart:${row.thread_id}:${last.id}`,
              row.thread_id,
              "workflowd app-server restarted. Continue the interrupted task from its durable state. Do not repeat completed external actions.",
            )
        }
      })
      yield* restore()
      const flushUnlocked = Effect.fn("Resident.flush")(function* () {
        for (const message of yield* store.pending()) {
          const row = yield* store.read(message.thread_id)
          if (row === null || row.state === "operator_required" || row.state === "finished") {
            yield* store.uncertain(message.id, message.thread_id)
            continue
          }
          if (!message.id.startsWith("dispatch:") && !(yield* hasCustody(message.thread_id))) {
            yield* store.uncertain(message.id, message.thread_id)
            yield* finish(message.thread_id, true)
            continue
          }
          yield* store.sending(message.id)
          const outcome = yield* deliverResident((method, params) => {
            const decoded = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
              params,
            )
            const threadId = Schema.decodeUnknownSync(Schema.String)(decoded.threadId)
            return request(method, { ...decoded, threadId })
          }, message)
          if (outcome === "delivered") yield* store.delivered(message.id)
          else {
            yield* store.uncertain(message.id, message.thread_id)
            yield* finish(message.thread_id, true)
          }
        }
      })
      const flush = () => Semaphore.withPermits(deliveryLock, 1)(flushUnlocked())
      const tick = Effect.gen(function* () {
        for (const row of yield* store.threads()) {
          const entry = servers.get(row.run_id)
          if (
            entry !== undefined &&
            row.state === "active" &&
            Date.now() - entry.lastEventAt >= (config.progressWindowMs ?? 20 * 60_000)
          ) {
            yield* store.uncertain(`stall:${row.thread_id}`, row.thread_id)
            yield* finish(row.thread_id, true)
            continue
          }
          if (entry?.disconnected) {
            if (entry.attempts >= 3) {
              yield* store.uncertain(`restart:${row.thread_id}`, row.thread_id)
              yield* finish(row.thread_id, true)
              continue
            }
            peers.revoke(row.run_id)
            yield* Effect.tryPromise(() => entry.process.close())
            yield* launch(row.run_id, entry.attempts + 1)
            yield* restore(row.thread_id)
          }
        }
        yield* subscriptions.reconcile()
        for (const runId of servers.keys()) {
          const run = yield* runs.read(runId)
          if (run?.state === "operator_required" && run.nativeSessionId !== null)
            yield* finish(run.nativeSessionId, true)
        }
        yield* flush()
      })
      yield* tick.pipe(
        Effect.catch(() =>
          Effect.logWarning("Resident inbox pass failed; durable intent retained"),
        ),
        Effect.repeat(Schedule.spaced(1000)),
        Effect.forkScoped,
      )

      const cancelRun = Effect.fn("Resident.cancel")(
        function* (runId: string) {
          const run = yield* runs.read(runId)
          if (run?.nativeSessionId === null || run?.nativeSessionId === undefined) return
          const threadId = run.nativeSessionId
          yield* store.uncertain(`cancel:${runId}`, threadId)
          yield* finish(threadId, true)
        },
        Effect.mapError(
          (cause) =>
            new WorkspaceError({
              operation: "cancel resident thread",
              cause,
            }),
        ),
      )
      const cli: CodexCliPort = {
        ownership: "resident-thread",
        cancelRun,
        preflight: Effect.acquireUseRelease(
          Effect.try(() => start({ binary, home: config.home }, () => {})),
          (process) =>
            Effect.tryPromise(async () => {
              await process.initialize()
              await process.rpc.request("thread/list", { limit: 1 })
            }),
          (process) => Effect.tryPromise(() => process.close()).pipe(Effect.orDie),
        ).pipe(
          Effect.mapError(() => ({
            kind: "cli_unusable" as const,
            detail: "resident Codex app-server unavailable",
          })),
        ),
        spawn: (input) =>
          Effect.gen(function* () {
            if (input.runId === undefined)
              return yield* Effect.fail(new Error("Resident dispatch requires a durable run ID"))
            const server = yield* launch(input.runId)
            input.onSpawn?.(server.pid)
            const thread = yield* Effect.tryPromise(() =>
              server.rpc.request("thread/start", {
                cwd: input.directory,
                model: input.model,
                ...(input.provider == null ? {} : { modelProvider: input.provider }),
                ...(input.effort === undefined
                  ? {}
                  : { config: { model_reasoning_effort: input.effort } }),
                approvalPolicy: "never",
                sandbox: "danger-full-access",
              }),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ThreadResult)))
            const rejectSelection = (
              reason: "unsupported_thinking" | "model_not_available",
              detail: string,
            ) =>
              Effect.gen(function* () {
                peers.revoke(input.runId)
                servers.delete(input.runId)
                yield* Effect.tryPromise(() => server.close())
                return yield* Effect.fail(new ExecutionSelectionError({ reason, detail }))
              })
            if (input.effort !== undefined && thread.reasoningEffort !== input.effort)
              return yield* rejectSelection(
                "unsupported_thinking",
                "Native Codex did not confirm the requested reasoning effort",
              )
            if (input.model !== null && thread.model !== input.model)
              return yield* rejectSelection(
                "model_not_available",
                "Native Codex resolved a different model",
              )
            if (input.provider != null && thread.modelProvider !== input.provider)
              return yield* rejectSelection(
                "model_not_available",
                "Native Codex resolved a different provider",
              )
            const accepted = yield* runs.read(input.runId)
            if (accepted?.resolvedSelection != null && thread.model !== undefined) {
              yield* runs.recordResolvedSelection({
                runId: input.runId,
                now: new Date(),
                selection: {
                  ...accepted.resolvedSelection,
                  model: thread.model,
                  provider: thread.modelProvider ?? accepted.resolvedSelection.provider,
                  thinking:
                    thread.reasoningEffort == null
                      ? accepted.resolvedSelection.thinking
                      : { ...accepted.resolvedSelection.thinking, effort: thread.reasoningEffort },
                  evidence: "runtime",
                },
              })
            }
            const threadId = thread.thread.id
            threadRuns.set(threadId, input.runId)
            yield* store.attach(input.runId, threadId, input.directory, input.model)
            const queue = makeEventQueue()
            let resolveExit: (exit: CodexExit) => void = () => {}
            const exited = new Promise<CodexExit>((resolve) => {
              resolveExit = resolve
            })
            listeners.set(threadId, { queue, finish: resolveExit })
            queue.push({ type: "thread.started", threadId })
            const instructions = `You are a resident workflowd worker. After pushing, use subscribe_to_event with {"kind":"ci","repository":"OWNER/NAME","sha":"HEAD_SHA"}, or {"kind":"agent_run","run_id":"RUN_ID"}. Equivalent shell call: bun ${JSON.stringify(import.meta.dir + "/subscribe.ts")} --repo OWNER/NAME --sha HEAD_SHA (or --agent-run RUN_ID). After registration succeeds, END YOUR TURN. workflowd will queue one completion message. Do not sleep or poll.\n\n`
            yield* store.enqueue(`dispatch:${input.runId}`, threadId, instructions + input.prompt)
            yield* flush()
            return {
              events: queue.iterable,
              executionId: threadId,
              cancel: cancelRun(input.runId),
              exited: Effect.tryPromise({
                try: () => exited,
                catch: (cause) =>
                  new WorkspaceError({
                    operation: "observe resident exit",
                    cause: normalizeError(cause),
                  }),
              }),
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ExecutionSelectionError
                ? error
                : new WorkspaceError({
                    operation: "resident dispatch",
                    cause: new Error("resident dispatch failed; inspect durable inbox"),
                  }),
            ),
          ),
      }
      const route: ResidentPort["route"] = (request, peerPid) =>
        Effect.gen(function* () {
          if (new URL(request.url).pathname !== "/subscriptions") return undefined
          if (request.method !== "POST") return new Response(null, { status: 405 })
          if (peerPid === undefined) return new Response(null, { status: 403 })
          const input = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(Subscribe)(value, { onExcessProperty: "error" }),
            ),
          )
          if (!peers.allows(input.runId, peerPid)) return new Response(null, { status: 403 })
          const run = yield* runs.read(input.runId)
          if (
            run?.state !== "verified" ||
            run.nativeSessionId === null ||
            !(yield* hasCustody(run.nativeSessionId))
          )
            return new Response(null, { status: 403 })
          const selector = input.selector
          if (selector.kind === "ci") {
            const repository = ciConfig.repositories.find(
              (r) =>
                r.repository === selector.repository.toLowerCase() &&
                (r.dispatchRepository ?? r.repository) === run.repository,
            )
            if (repository === undefined) return new Response(null, { status: 403 })
            yield* ci.watch(
              { repository: selector.repository.toLowerCase(), sha: selector.sha.toLowerCase() },
              repository.installationId,
              repository.workflows,
              Date.now(),
            )
          } else {
            const child = yield* runs.read(selector.run_id)
            if (child === null || child.runId === run.runId || child.repository !== run.repository)
              return new Response(null, { status: 403 })
          }
          const receipt = yield* subscriptions.register(run.nativeSessionId, selector)
          yield* flush()
          const deliveryState = yield* store.deliveryState(receipt.id)
          return Response.json(
            {
              ...receipt,
              deliveryState,
              instruction:
                deliveryState === "operator_required"
                  ? "Mailbox delivery requires operator attention; report the subscription ID."
                  : "End this turn; workflowd will queue one completion message.",
            },
            { status: 202 },
          )
        }).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 409 }))))
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          serveRunSocket(config.socket, (request, pid) => Effect.runPromise(route(request, pid))),
        ),
        (server) => Effect.tryPromise(() => server.close()).pipe(Effect.orDie),
      )
      return { cli, route }
    }),
  )
