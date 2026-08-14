import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Schema } from "effect"
import type { OpenCodeSessionEvent } from "../opencode/adapter"
import { WorkSignal } from "../work-signal"
import {
  AgentHandoffStore,
  MAX_AGENT_COMPLETION_BASELINE_MESSAGES,
  recordAgentSessionCompletion,
  type RegisterAgentWaitInput,
} from "./agent-handoff-store"
import type {
  KernelStoreConflictError,
  KernelStoreDataError,
  KernelStoreInputError,
} from "./event-store"

type CompletionMessage = Extract<
  OpenCodeSessionEvent,
  { readonly type: "message.updated" }
>["message"]

export type OpenCodeCompletionProviderPort = {
  readonly sessionExists: (
    input: { readonly sessionID: string; readonly directory: string },
    signal: AbortSignal,
  ) => Promise<boolean>
  readonly listMessages: (
    input: { readonly sessionID: string; readonly directory: string },
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<CompletionMessage>>
  readonly subscribeEvents: (
    input: { readonly directory: string },
    signal: AbortSignal,
  ) => Promise<AsyncIterable<OpenCodeSessionEvent>>
}

export const OpenCodeCompletionProvider = Context.GenericTag<OpenCodeCompletionProviderPort>(
  "workflowd/kernel/OpenCodeCompletionProvider",
)

export type OpenCodeCompletionSourceOptions = {
  readonly owningHostId: string
  readonly providerId: string
  readonly serverId: string
  readonly endpointAlias: string
  readonly endpointIdentity: string
  readonly providerVersion: number
  readonly now: () => Date
}

export type OpenCodeCompletionSourcePort = {
  readonly iteration: Effect.Effect<
    "idle" | "completed" | "operator_required",
    | OpenCodeCompletionSourceError
    | SqlError
    | KernelStoreConflictError
    | KernelStoreDataError
    | KernelStoreInputError
  >
}

export const OpenCodeCompletionSource = Context.GenericTag<OpenCodeCompletionSourcePort>(
  "workflowd/kernel/OpenCodeCompletionSource",
)

export class OpenCodeCompletionSourceError extends Data.TaggedError(
  "OpenCodeCompletionSourceError",
)<{
  readonly operation: string
  readonly cause: unknown
}> {}

const WatchRow = Schema.Struct({
  instance_id: Schema.String,
  wait_id: Schema.String,
  child_session_id: Schema.String,
  child_session_generation: Schema.Int.pipe(Schema.positive()),
  provider_kind: Schema.Literal("opencode"),
  provider_version: Schema.Int.pipe(Schema.positive()),
  provider_id: Schema.String,
  server_id: Schema.String,
  owning_host_id: Schema.String,
  endpoint_alias: Schema.String,
  endpoint_identity: Schema.String,
  native_session_id: Schema.String,
  resource_id: Schema.String,
  baseline_version: Schema.Literal(1),
  baseline_json: Schema.parseJson(
    Schema.Struct({
      version: Schema.Literal(1),
      messageFingerprints: Schema.Array(Schema.String).pipe(
        Schema.maxItems(MAX_AGENT_COMPLETION_BASELINE_MESSAGES),
      ),
    }),
  ),
  state: Schema.Literal("watching"),
  registered_at: Schema.String,
  absolute_path: Schema.String,
  resource_state: Schema.Literal("reserved"),
  session_state: Schema.Literal("ready", "active"),
  session_revision: Schema.Int.pipe(Schema.positive()),
  current_provider_kind: Schema.Literal("opencode", "codex", "claude"),
  current_provider_version: Schema.Int.pipe(Schema.positive()),
  current_provider_id: Schema.String,
  current_server_id: Schema.String,
  current_owning_host_id: Schema.String,
  current_endpoint_alias: Schema.String,
  current_endpoint_identity: Schema.String,
  current_native_session_id: Schema.String,
  current_resource_id: Schema.String,
})

const RegistrationCustodyRow = Schema.Struct({
  session_id: Schema.String,
  provider_kind: Schema.Literal("opencode"),
  provider_version: Schema.Int.pipe(Schema.positive()),
  provider_id: Schema.String,
  server_id: Schema.String,
  owning_host_id: Schema.String,
  endpoint_alias: Schema.String,
  endpoint_identity: Schema.String,
  native_session_id: Schema.String,
  revision: Schema.Int.pipe(Schema.positive()),
  state: Schema.Literal("ready", "active"),
  absolute_path: Schema.String,
  resource_state: Schema.Literal("reserved"),
})

const sourceError = (operation: string) => (cause: unknown) =>
  new OpenCodeCompletionSourceError({ operation, cause })

const providerCall = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: sourceError(operation) })

export const openCodeMessageFingerprint = (message: CompletionMessage): string =>
  message.id === undefined
    ? createHash("sha256")
        .update(
          JSON.stringify({
            created: message.time.created,
            completed: message.time.completed ?? null,
            structured: message.structured ?? null,
            error: message.error ?? null,
          }),
        )
        .digest("hex")
    : `id:${message.id}`

const isTerminalAnswer = (message: CompletionMessage) =>
  message.time.completed !== undefined && message.error === undefined

const custodyMatches = (watch: typeof WatchRow.Type, options: OpenCodeCompletionSourceOptions) =>
  watch.provider_version === options.providerVersion &&
  watch.provider_id === options.providerId &&
  watch.server_id === options.serverId &&
  watch.owning_host_id === options.owningHostId &&
  watch.endpoint_alias === options.endpointAlias &&
  watch.endpoint_identity === options.endpointIdentity &&
  watch.child_session_generation === watch.session_revision &&
  watch.current_provider_kind === watch.provider_kind &&
  watch.current_provider_version === watch.provider_version &&
  watch.current_provider_id === watch.provider_id &&
  watch.current_server_id === watch.server_id &&
  watch.current_owning_host_id === watch.owning_host_id &&
  watch.current_endpoint_alias === watch.endpoint_alias &&
  watch.current_endpoint_identity === watch.endpoint_identity &&
  watch.current_native_session_id === watch.native_session_id &&
  watch.current_resource_id === watch.resource_id

const firstTerminalEvent = async (
  stream: AsyncIterable<OpenCodeSessionEvent>,
  nativeSessionId: string,
  signal: AbortSignal,
) => {
  const iterator = stream[Symbol.asyncIterator]()
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("completion observation interrupted")),
      {
        once: true,
      },
    )
  })
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) throw new Error("OpenCode completion event stream disconnected")
      const event = next.value
      if (
        event.type === "message.updated" &&
        event.sessionID === nativeSessionId &&
        isTerminalAnswer(event.message)
      ) {
        return event.message
      }
    }
  } finally {
    await iterator.return?.()
  }
}

const markOperatorRequired = (instanceId: string, now: Date, reason: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE kernel_agent_completion_watches SET state = 'operator_required',
      updated_at = ${now.toISOString()} WHERE instance_id = ${instanceId} AND state = 'watching'`
    return { status: "operator_required" as const, instanceId, reason }
  })

export const registerOpenCodeAgentWait = (
  input: Omit<RegisterAgentWaitInput, "baseline">,
  options: OpenCodeCompletionSourceOptions,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const handoffs = yield* AgentHandoffStore
    const provider = yield* OpenCodeCompletionProvider
    const signals = yield* WorkSignal
    // The workflow event cursor is established before inspecting provider history. Any
    // completion racing the history read and wait insertion is therefore still matchable.
    yield* handoffs.prepare(input)
    const rows = yield* sql`SELECT session.*, resource.absolute_path,
        resource.state AS resource_state
      FROM kernel_sessions AS session
      JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
      WHERE session.session_id = ${input.workflow.childSessionId}`
    const custody = yield* Schema.decodeUnknown(RegistrationCustodyRow)(rows[0]).pipe(
      Effect.mapError(sourceError("decode OpenCode child registration custody")),
    )
    const valid =
      custody.session_id === input.workflow.childSessionId &&
      custody.revision === input.workflow.childSessionGeneration &&
      custody.provider_version === options.providerVersion &&
      custody.provider_id === options.providerId &&
      custody.server_id === options.serverId &&
      custody.owning_host_id === options.owningHostId &&
      custody.endpoint_alias === options.endpointAlias &&
      custody.endpoint_identity === options.endpointIdentity
    if (!valid) {
      return yield* new OpenCodeCompletionSourceError({
        operation: "validate OpenCode child registration custody",
        cause: new Error("child session does not belong to this completion source"),
      })
    }
    const reference = {
      sessionID: custody.native_session_id,
      directory: custody.absolute_path,
    }
    const exists = yield* providerCall("inspect OpenCode child before waiting", (signal) =>
      provider.sessionExists(reference, signal),
    )
    if (!exists) {
      return yield* new OpenCodeCompletionSourceError({
        operation: "inspect OpenCode child before waiting",
        cause: new Error("child session is missing"),
      })
    }
    const history = yield* providerCall("capture OpenCode child history baseline", (signal) =>
      provider.listMessages(reference, signal),
    )
    if (history.length > MAX_AGENT_COMPLETION_BASELINE_MESSAGES) {
      return yield* new OpenCodeCompletionSourceError({
        operation: "capture OpenCode child history baseline",
        cause: new Error("child history exceeds its bound"),
      })
    }
    const registered = yield* handoffs.register({
      ...input,
      baseline: {
        version: 1,
        messageFingerprints: history.filter(isTerminalAnswer).map(openCodeMessageFingerprint),
      },
    })
    yield* signals.wake("agent-completion")
    return registered
  })

export const runOpenCodeCompletionSourceIteration = (options: OpenCodeCompletionSourceOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const provider = yield* OpenCodeCompletionProvider
    const signals = yield* WorkSignal
    const rows = yield* sql`SELECT watch.*,
        resource.absolute_path, resource.state AS resource_state,
        session.state AS session_state, session.revision AS session_revision,
        session.provider_kind AS current_provider_kind,
        session.provider_version AS current_provider_version,
        session.provider_id AS current_provider_id,
        session.server_id AS current_server_id,
        session.owning_host_id AS current_owning_host_id,
        session.endpoint_alias AS current_endpoint_alias,
        session.endpoint_identity AS current_endpoint_identity,
        session.native_session_id AS current_native_session_id,
        session.resource_id AS current_resource_id
      FROM kernel_agent_completion_watches AS watch
      JOIN kernel_sessions AS session ON session.session_id = watch.child_session_id
      JOIN kernel_working_resources AS resource ON resource.resource_id = watch.resource_id
      WHERE watch.provider_kind = 'opencode' AND watch.owning_host_id = ${options.owningHostId}
        AND watch.state = 'watching'
      ORDER BY watch.registered_at, watch.instance_id LIMIT 1`
    if (rows.length === 0) return { status: "idle" as const }
    const decoded = yield* Schema.decodeUnknown(WatchRow)(rows[0]).pipe(
      Effect.mapError(sourceError("decode saved OpenCode completion watch")),
      Effect.either,
    )
    if (decoded._tag === "Left") {
      const instanceId = typeof rows[0]?.instance_id === "string" ? rows[0].instance_id : ""
      if (instanceId.length === 0) return yield* decoded.left
      return yield* markOperatorRequired(instanceId, options.now(), "corrupt_saved_watch")
    }
    const watch = decoded.right
    if (!custodyMatches(watch, options)) {
      return yield* markOperatorRequired(watch.instance_id, options.now(), "custody_mismatch")
    }
    const directory = yield* Effect.tryPromise({
      try: () => stat(watch.absolute_path),
      catch: sourceError("validate watched OpenCode directory"),
    })
    if (!directory.isDirectory()) {
      return yield* markOperatorRequired(
        watch.instance_id,
        options.now(),
        "missing_working_directory",
      )
    }
    const reference = { sessionID: watch.native_session_id, directory: watch.absolute_path }
    const exists = yield* providerCall("inspect watched OpenCode session", (signal) =>
      provider.sessionExists(reference, signal),
    )
    if (!exists) {
      return yield* markOperatorRequired(watch.instance_id, options.now(), "missing_child_session")
    }

    // Subscribe before catch-up so a completion in the registration window is covered by
    // either bounded history or the already-open stream.
    const stream = yield* providerCall("subscribe to OpenCode completion events", (signal) =>
      provider.subscribeEvents({ directory: watch.absolute_path }, signal),
    )
    const history = yield* providerCall("catch up OpenCode completion history", (signal) =>
      provider.listMessages(reference, signal),
    )
    if (history.length > MAX_AGENT_COMPLETION_BASELINE_MESSAGES) {
      return yield* markOperatorRequired(watch.instance_id, options.now(), "history_exceeds_bound")
    }
    const baseline = new Set(watch.baseline_json.messageFingerprints)
    const candidates = history.filter(
      (message) => isTerminalAnswer(message) && !baseline.has(openCodeMessageFingerprint(message)),
    )
    if (candidates.length > 1) {
      return yield* markOperatorRequired(watch.instance_id, options.now(), "ambiguous_new_answers")
    }
    const message =
      candidates[0] ??
      (yield* providerCall("observe OpenCode completion event", (signal) =>
        firstTerminalEvent(stream, watch.native_session_id, signal),
      ))
    const registeredAt = new Date(watch.registered_at)
    if (
      Number.isNaN(registeredAt.getTime()) ||
      message.time.completed === undefined ||
      message.time.completed < registeredAt.getTime()
    ) {
      return yield* markOperatorRequired(watch.instance_id, options.now(), "stale_completion")
    }
    if (message.id === undefined) {
      return yield* markOperatorRequired(
        watch.instance_id,
        options.now(),
        "missing_message_identity",
      )
    }
    const identity = createHash("sha256")
      .update(
        [
          watch.provider_kind,
          watch.provider_id,
          watch.server_id,
          watch.endpoint_identity,
          watch.native_session_id,
          message.id,
        ].join("\0"),
      )
      .digest("hex")
    const completedAt = new Date(message.time.completed)
    const source = `agent-session-source:${watch.provider_kind}:${createHash("sha256")
      .update(`${watch.provider_id}\0${watch.server_id}\0${watch.endpoint_identity}`)
      .digest("hex")}`
    const recorded = yield* Effect.gen(function* () {
      const result = yield* recordAgentSessionCompletion({
        source,
        sourceEventId: identity,
        childSessionId: watch.child_session_id,
        childSessionGeneration: watch.child_session_generation,
        completionId: identity,
        completedAt,
      })
      yield* sql`UPDATE kernel_agent_completion_watches SET state = 'completed',
        completion_event_sequence = ${result.event.sequence}, updated_at = ${options.now().toISOString()}
        WHERE instance_id = ${watch.instance_id} AND state = 'watching'`
      return result
    }).pipe(sql.withTransaction)
    yield* signals.wake("kernel-job")
    return {
      status: "completed" as const,
      childSessionId: watch.child_session_id,
      eventSequence: recorded.event.sequence,
    }
  })

export type OpenCodeCompletionSourceIterationError = SqlError | OpenCodeCompletionSourceError
