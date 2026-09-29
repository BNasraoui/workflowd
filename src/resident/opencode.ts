import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { OpenCodeAdapter, OpenCodeAdapterError } from "../opencode/adapter"
import type { OpenCodeCompletionSourceOptions } from "../kernel/opencode-completion-source"
import { AgentRunStore } from "../kernel/agent-run-store"
import { CiService } from "../ci/service"
import type { CiConfig } from "../ci/config"
import { serveRunSocket } from "../worker-identity/peer"
import { makeResidentStore } from "./store"
import { EventSelector, makeSubscriptions } from "./subscriptions"
import { deliverOpenCode } from "./opencode-delivery"

export type OpenCodeMailboxProvider = Pick<OpenCodeAdapter, "sessionExists" | "promptSession"> & {
  readonly setSessionEnvironment: (input: {
    readonly sessionID: string
    readonly variables: Readonly<Record<string, string>>
  }) => Effect.Effect<void, OpenCodeAdapterError>
}
type Options = Omit<OpenCodeCompletionSourceOptions, "now" | "observationTimeoutMs"> & {
  readonly socket: string
  readonly repositories: CiConfig["repositories"]
}
const Subscribe = Schema.Struct({
  runId: Schema.NonEmptyString,
  capability: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  selector: EventSelector,
})
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export const makeOpenCodeMailbox = (options: Options, provider: OpenCodeMailboxProvider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const runs = yield* AgentRunStore
    const ci = yield* CiService
    const inbox = yield* makeResidentStore
    const subscriptions = yield* makeSubscriptions
    const lock = yield* Semaphore.make(1)
    const custody = Effect.fn("OpenCodeMailbox.custody")(function* (runId: string) {
      const rows = yield* sql`SELECT a.run_id FROM kernel_agent_runs a
      JOIN kernel_sessions s ON s.session_id = a.session_id AND s.native_session_id = a.native_session_id
      JOIN kernel_working_resources r ON r.resource_id = s.resource_id AND r.resource_id = a.resource_id AND r.absolute_path = a.directory
      WHERE a.run_id = ${runId} AND a.state IN ('spawned','verified')
      AND s.provider_kind = 'opencode' AND s.provider_version = ${options.providerVersion}
      AND s.provider_id = ${options.providerId} AND s.server_id = ${options.serverId}
      AND s.owning_host_id = ${options.owningHostId} AND r.owning_host_id = ${options.owningHostId}
      AND s.endpoint_alias = ${options.endpointAlias} AND s.endpoint_identity = ${options.endpointIdentity}
      AND s.state IN ('ready','active') AND r.state = 'reserved'`
      return rows.length === 1
    })
    const prepare = Effect.fn("OpenCodeMailbox.prepare")(function* (runId: string) {
      const run = yield* runs.read(runId)
      if (run?.nativeSessionId == null || !(yield* custody(runId)))
        return yield* Effect.fail(new Error("OpenCode mailbox custody unavailable"))
      const capability = randomBytes(32).toString("hex")
      yield* inbox.attach(
        runId,
        run.nativeSessionId,
        run.directory,
        run.modelId,
        "opencode",
        hash(capability),
      )
      yield* inbox.started(run.nativeSessionId, "dispatch")
      yield* provider.setSessionEnvironment({
        sessionID: run.nativeSessionId,
        variables: {
          WORKFLOWD_RUN_ID: runId,
          WORKFLOWD_OPENCODE_RESIDENT_SOCKET: options.socket,
          WORKFLOWD_SUBSCRIPTION_CAPABILITY: capability,
        },
      })
      return `You are a resident workflowd worker. After pushing, subscribe with: bun ${JSON.stringify(import.meta.dir + "/subscribe.ts")} --repo OWNER/NAME --sha HEAD_SHA (or --agent-run RUN_ID). The subscribe_to_event MCP tool in ${import.meta.dir}/mcp.ts uses the same session environment. Wait for the registration receipt, then end your turn; workflowd sends one completion message. Never print the subscription capability or poll for completion.`
    })
    const uncertain = Effect.fn("OpenCodeMailbox.uncertain")(function* (
      id: string,
      threadId: string,
      runId: string,
    ) {
      yield* inbox.uncertain(id, threadId)
      const run = yield* runs.read(runId)
      if (run !== null && ["accepted", "spawning", "spawned", "verified"].includes(run.state))
        yield* runs.operatorRequired({
          runId,
          diagnostic: "opencode_mailbox_delivery_uncertain",
          now: new Date(),
        })
    })
    const flush = Effect.gen(function* () {
      for (const message of yield* inbox.pending("opencode")) {
        const row = yield* inbox.read(message.thread_id)
        if (row === null) continue
        const run = yield* runs.read(row.run_id)
        if (
          row.state === "finished" ||
          row.state === "operator_required" ||
          run?.state !== "verified" ||
          run.nativeSessionId !== row.thread_id ||
          run.directory !== row.directory ||
          !(yield* custody(row.run_id))
        ) {
          yield* uncertain(message.id, row.thread_id, row.run_id)
          continue
        }
        yield* inbox.sending(message.id)
        const outcome = yield* deliverOpenCode(provider, message, run)
        if (outcome === "delivered") yield* inbox.delivered(message.id)
        else yield* uncertain(message.id, row.thread_id, row.run_id)
      }
    })
    const tick = Semaphore.withPermits(
      lock,
      1,
    )(subscriptions.reconcile().pipe(Effect.andThen(flush)))
    const route = Effect.fn("OpenCodeMailbox.route")(
      function* (request: Request) {
        if (new URL(request.url).pathname !== "/subscriptions")
          return new Response(null, { status: 404 })
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const input = yield* Effect.tryPromise(() => request.json()).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Subscribe)(value, { onExcessProperty: "error" }),
          ),
        )
        const run = yield* runs.read(input.runId)
        if (run?.state !== "verified" || run.nativeSessionId === null)
          return new Response(null, { status: 403 })
        const row = yield* inbox.read(run.nativeSessionId)
        if (
          row?.provider_kind !== "opencode" ||
          row.run_id !== run.runId ||
          row.capability_hash === null ||
          !timingSafeEqual(Buffer.from(hash(input.capability)), Buffer.from(row.capability_hash)) ||
          !(yield* custody(run.runId))
        )
          return new Response(null, { status: 403 })
        const selector = input.selector
        if (selector.kind === "ci") {
          const repository = options.repositories.find(
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
        yield* tick
        const deliveryState = yield* inbox.deliveryState(receipt.id)
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
      },
      Effect.catch(() => Effect.succeed(new Response(null, { status: 409 }))),
    )
    return { prepare, route, tick }
  })

export const OpenCodeMailbox = Context.Service<
  Effect.Success<ReturnType<typeof makeOpenCodeMailbox>>
>("workflowd/OpenCodeMailbox")
export const OpenCodeMailboxLive = (options: Options, provider: OpenCodeMailboxProvider) =>
  Layer.effect(
    OpenCodeMailbox,
    Effect.gen(function* () {
      const mailbox = yield* makeOpenCodeMailbox(options, provider)
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          serveRunSocket(options.socket, (request) => Effect.runPromise(mailbox.route(request))),
        ),
        (server) => Effect.tryPromise(() => server.close()).pipe(Effect.orDie),
      )
      yield* mailbox.tick.pipe(
        Effect.catch(() =>
          Effect.logWarning("OpenCode mailbox pass failed; durable intent retained"),
        ),
        Effect.repeat(Schedule.spaced(1000)),
        Effect.forkScoped,
      )
      return mailbox
    }),
  )
