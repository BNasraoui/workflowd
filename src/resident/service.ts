import { createHash, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Queue, Schedule, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CiService } from "../ci/service"
import { CiTarget } from "../ci/event"
import type { CiConfig } from "../ci/config"
import { AgentRunStore } from "../kernel/agent-run-store"
import { makeEventQueue, type CodexCliPort, type CodexExit } from "../kernel/codex-session"
import { WorkspaceError } from "../workspace/errors"
import { makeResidentStore } from "./store"
import { startAppServer } from "./process"
import { deliverResident } from "./delivery"
import type { ResidentConfig } from "./config"

const ThreadResult = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const TurnEvent = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({ id: Schema.String, status: Schema.String }),
})
const ItemEvent = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
})
const Wait = Schema.Struct({
  threadId: Schema.NonEmptyString,
  ...CiTarget.fields,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 86400000 })),
})
const History = Schema.Struct({
  thread: Schema.Struct({
    turns: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  }),
})
type ResidentPort = {
  readonly cli: CodexCliPort
  readonly route: (request: Request) => Effect.Effect<Response | undefined>
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
      const runs = yield* AgentRunStore
      const ci = yield* CiService
      const sql = yield* SqlClient.SqlClient
      const notifications = yield* Queue.unbounded<{
        readonly method: string
        readonly params: unknown
      }>()
      let disconnected = false
      const launch = () =>
        start({ binary, home: config.home }, (frame) => {
          if (frame.method === "workflowd/disconnected") disconnected = true
          Queue.offerUnsafe(notifications, frame)
        })
      let server: ReturnType<typeof startAppServer> = yield* Effect.acquireRelease(
        Effect.try(launch),
        () => Effect.tryPromise(() => server.close()).pipe(Effect.ignore),
      )
      yield* Effect.tryPromise(() => server.initialize())
      const listeners = new Map<
        string,
        { queue: ReturnType<typeof makeEventQueue>; finish: (exit: CodexExit) => void }
      >()
      const request = (method: string, params: unknown) => server.rpc.request(method, params)
      const finish = Effect.fn("Resident.finish")(function* (threadId: string, failed: boolean) {
        const row = yield* store.read(threadId)
        const listener = listeners.get(threadId)
        listener?.queue.close()
        listener?.finish({ exitCode: failed ? 1 : 0, stderr: "" })
        listeners.delete(threadId)
        if (row !== null) {
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
          const state = yield* store.completed(event.threadId, event.turn.id)
          if (state === "finished" || event.turn.status === "failed")
            yield* finish(event.threadId, event.turn.status !== "completed")
        }
      })
      yield* Effect.forever(
        Queue.take(notifications).pipe(
          Effect.flatMap(handle),
          Effect.catch(() => Effect.logWarning("Resident notification rejected")),
        ),
      ).pipe(Effect.forkScoped)

      const restore = Effect.fn("Resident.restore")(function* () {
        for (const row of yield* store.threads()) {
          yield* Effect.tryPromise(() =>
            request("thread/resume", {
              threadId: row.thread_id,
              cwd: row.directory,
              model: row.model,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            }),
          )
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
      const deliveryLock = yield* Semaphore.make(1)
      const flushUnlocked = Effect.fn("Resident.flush")(function* () {
        for (const message of yield* store.pending()) {
          const row = yield* store.read(message.thread_id)
          if (row === null || row.state === "operator_required" || row.state === "finished")
            continue
          yield* store.sending(message.id)
          const outcome = yield* deliverResident(request, message)
          if (outcome === "delivered") yield* store.delivered(message.id)
          else {
            yield* store.uncertain(message.id, message.thread_id)
            yield* finish(message.thread_id, true)
          }
        }
      })
      const flush = () => Semaphore.withPermits(deliveryLock, 1)(flushUnlocked())
      let restartAttempts = 0
      const tick = Effect.gen(function* () {
        if (disconnected) {
          if (restartAttempts >= 3)
            return yield* Effect.fail(new Error("Resident restart budget exhausted"))
          restartAttempts++
          server = yield* Effect.try(launch)
          yield* Effect.tryPromise(() => server.initialize())
          disconnected = false
          yield* restore()
        }
        for (const row of yield* store.threads()) {
          // Local liveness events keep the legacy first-token drain from treating
          // a registered CI wait as a silent stalled model turn.
          listeners.get(row.thread_id)?.queue.push({ type: "other" })
          if (row.state !== "waiting" || row.wait_repo === null || row.wait_sha === null) continue
          const state = yield* ci.read({ repository: row.wait_repo, sha: row.wait_sha })
          if (state !== null && state.conclusion !== "pending") {
            yield* store.enqueue(
              `ci:${row.thread_id}:${row.wait_turn}:${state.sequence}`,
              row.thread_id,
              `CI completion event: ${JSON.stringify(state)}. Continue the task; do not poll GitHub.`,
            )
          } else if (row.wait_deadline !== null && Date.now() >= row.wait_deadline) {
            yield* store.enqueue(
              `ci-timeout:${row.thread_id}:${row.wait_turn}`,
              row.thread_id,
              "CI wait timed out. Report the timeout or register a new bounded wait; do not poll GitHub.",
            )
          }
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

      const cli: CodexCliPort = {
        preflight: Effect.tryPromise({
          try: () => request("thread/list", { limit: 1 }),
          catch: () => ({
            kind: "cli_unusable" as const,
            detail: "resident Codex app-server unavailable",
          }),
        }).pipe(Effect.asVoid),
        spawn: (input) =>
          Effect.gen(function* () {
            if (input.runId === undefined)
              return yield* Effect.fail(new Error("Resident dispatch requires a durable run ID"))
            const thread = yield* Effect.tryPromise(() =>
              request("thread/start", {
                cwd: input.directory,
                model: input.model,
                approvalPolicy: "never",
                sandbox: "danger-full-access",
              }),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ThreadResult)))
            const threadId = thread.thread.id
            yield* store.attach(input.runId, threadId, input.directory, input.model)
            const queue = makeEventQueue()
            let resolveExit: (exit: CodexExit) => void = () => {}
            const exited = new Promise<CodexExit>((resolve) => {
              resolveExit = resolve
            })
            listeners.set(threadId, { queue, finish: resolveExit })
            queue.push({ type: "thread.started", threadId })
            const instructions = `You are a resident workflowd worker. When waiting for CI, run bun ${JSON.stringify(`${import.meta.dir}/wait.ts`)} --thread ${JSON.stringify(threadId)} --repo OWNER/NAME --sha HEAD_SHA. After registration succeeds, say "waiting for CI" and END YOUR TURN. A CI event will start a new turn. Do not sleep or run gh pr checks --watch.\n\n`
            yield* store.enqueue(`dispatch:${input.runId}`, threadId, instructions + input.prompt)
            yield* flush()
            return {
              events: queue.iterable,
              exited: Effect.callback<CodexExit, WorkspaceError>((resume) => {
                let finished = false
                void exited.then((exit) => {
                  finished = true
                  resume(Effect.succeed(exit))
                })
                return Effect.gen(function* () {
                  if (finished) return
                  const row = yield* store.read(threadId)
                  if (row?.current_turn !== null && row?.current_turn !== undefined) {
                    yield* Effect.tryPromise(() =>
                      request("turn/interrupt", { threadId, turnId: row.current_turn }),
                    )
                  }
                  yield* finish(threadId, true)
                }).pipe(
                  Effect.catch(() =>
                    Effect.logWarning("Resident thread interruption requires operator attention"),
                  ),
                )
              }),
            }
          }).pipe(
            Effect.mapError(
              () =>
                new WorkspaceError({
                  operation: "resident dispatch",
                  cause: new Error("resident dispatch failed; inspect durable inbox"),
                }),
            ),
          ),
      }
      const route: ResidentPort["route"] = (request) =>
        Effect.gen(function* () {
          if (new URL(request.url).pathname !== "/ci/resident-waits") return undefined
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const hash = (text: string) => createHash("sha256").update(text).digest()
          if (
            !timingSafeEqual(
              hash(request.headers.get("authorization") ?? ""),
              hash(`Bearer ${config.token}`),
            )
          )
            return new Response(null, { status: 401 })
          const input = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Wait)),
          )
          const row = yield* store.read(input.threadId)
          if (row === null) return new Response(null, { status: 404 })
          const run = yield* runs.read(row.run_id)
          const repository = ciConfig.repositories.find(
            (r) =>
              r.repository === input.repository &&
              (r.dispatchRepository ?? r.repository) === run?.repository,
          )
          const custody =
            yield* sql`SELECT session_id FROM kernel_sessions WHERE native_session_id = ${input.threadId} AND provider_kind = 'codex' AND state IN ('ready','active')`
          if (
            repository === undefined ||
            run?.state !== "verified" ||
            run.nativeSessionId !== input.threadId ||
            custody.length !== 1
          )
            return new Response(null, { status: 403 })
          yield* ci.watch(input, repository.installationId, repository.workflows, Date.now())
          yield* store.wait(input.threadId, input, Date.now() + input.timeoutMs)
          return Response.json(
            { status: "waiting", instruction: "End this turn; workflowd will queue the CI event." },
            { status: 202 },
          )
        }).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 409 }))))
      return { cli, route }
    }),
  )
