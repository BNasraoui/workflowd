import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Schema } from "effect"
import type { ParseResult } from "effect"
import { boundedAgentPayload } from "../agent-payload"
import { JsonValueSchema } from "../json"
import type { OpenCodeAdapter, OpenCodeModel, OpenCodeSessionEvent } from "../opencode/adapter"
import { KernelSessionStore, type KernelSessionStoreError, type ResumeClaim } from "./session-store"
import { canonicalJson } from "./session-store-support"

const MAX_BASELINE_MESSAGES = 20

type ResumeMessage = Extract<OpenCodeSessionEvent, { readonly type: "message.updated" }>["message"]

export type OpenCodeResumeProviderPort = {
  readonly sessionExists: (
    input: { readonly sessionID: string; readonly directory: string },
    signal: AbortSignal,
  ) => Promise<boolean>
  readonly listMessages: (
    input: { readonly sessionID: string; readonly directory: string },
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<ResumeMessage>>
  readonly promptAsync: (
    input: {
      readonly sessionID: string
      readonly directory: string
      readonly prompt: string
      readonly agent: string
      readonly model: OpenCodeModel
      readonly jsonSchema: object
    },
    signal: AbortSignal,
  ) => Promise<void>
  readonly subscribeEvents: (
    input: { readonly directory: string },
    signal: AbortSignal,
  ) => Promise<AsyncIterable<OpenCodeSessionEvent>>
}

export const OpenCodeResumeProvider = Context.GenericTag<OpenCodeResumeProviderPort>(
  "workflowd/kernel/OpenCodeResumeProvider",
)

export class OpenCodeResumeAdapter implements OpenCodeResumeProviderPort {
  constructor(private readonly adapter: OpenCodeAdapter) {}

  readonly sessionExists: OpenCodeResumeProviderPort["sessionExists"] = (input, signal) =>
    this.adapter.sessionExists(input, signal)

  readonly listMessages: OpenCodeResumeProviderPort["listMessages"] = (input, signal) =>
    this.adapter.listSessionMessages(input, signal)

  readonly subscribeEvents: OpenCodeResumeProviderPort["subscribeEvents"] = (input, signal) =>
    this.adapter.subscribeSessionEvents(input, signal)

  readonly promptAsync: OpenCodeResumeProviderPort["promptAsync"] = (input, signal) =>
    this.adapter.promptSession(
      {
        sessionID: input.sessionID,
        directory: input.directory,
        agent: input.agent,
        model: input.model,
        format: { type: "json_schema", schema: input.jsonSchema, retryCount: 2 },
        parts: [{ type: "text", text: input.prompt }],
      },
      signal,
    )
}

export type TrustedResumeContract = {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Schema.AnyNoContext
  readonly jsonSchema: object
  readonly agent: string
  readonly model: OpenCodeModel
  readonly maxOutputBytes: number
}

export type OpenCodeResumeWorkerOptions = {
  readonly owningHostId: string
  readonly workerId: string
  readonly providerId: string
  readonly serverId: string
  readonly endpointAlias: string
  readonly endpointIdentity: string
  readonly providerVersion: number
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly now: () => Date
  readonly contracts: ReadonlyArray<TrustedResumeContract>
}

export class OpenCodeResumeWorkerError extends Data.TaggedError("OpenCodeResumeWorkerError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export type OpenCodeResumeWorkerPort = {
  readonly iteration: Effect.Effect<
    "idle" | "completed" | "missing" | "operator_required",
    OpenCodeResumeWorkerError | KernelSessionStoreError | SqlError | ParseResult.ParseError
  >
}

export const OpenCodeResumeWorker = Context.GenericTag<OpenCodeResumeWorkerPort>(
  "workflowd/kernel/OpenCodeResumeWorker",
)

const SessionRow = Schema.Struct({
  session_id: Schema.String,
  provider_kind: Schema.Literal("opencode", "codex", "claude"),
  provider_version: Schema.Int,
  provider_id: Schema.String,
  server_id: Schema.String,
  owning_host_id: Schema.String,
  endpoint_alias: Schema.String,
  endpoint_identity: Schema.String,
  native_session_id: Schema.String,
  resource_id: Schema.String,
})

const ResourceRow = Schema.Struct({
  resource_id: Schema.String,
  owning_host_id: Schema.String,
  absolute_path: Schema.String,
  state: Schema.String,
})

const ObservationRequestRow = Schema.Struct({
  request_id: Schema.String,
  session_id: Schema.String,
  owning_host_id: Schema.String,
  attempt: Schema.Int,
  output_contract: Schema.NullOr(Schema.String),
  output_contract_version: Schema.NullOr(Schema.Int),
})

const BaselineCheckpoint = Schema.Struct({ messages: Schema.Array(Schema.String) })
const CompletedObservationEvidence = Schema.Struct({
  reason: Schema.Literal("uniquely_attributed_answer"),
  result: JsonValueSchema,
})

const providerCall = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OpenCodeResumeWorkerError({ operation, cause }),
  })

const authority = (claim: ResumeClaim, now: Date) => ({
  requestId: claim.requestId,
  attempt: claim.attempt,
  owningHostId: claim.owningHostId,
  workerId: claim.workerId,
  claimToken: claim.claimToken,
  expectedLeaseUntil: claim.leaseUntil,
  now,
})

const sentAuthority = (claim: ResumeClaim, expectedLeaseUntil: Date, now: Date) => ({
  ...authority(claim, now),
  expectedLeaseUntil,
})

const fingerprint = (message: ResumeMessage) =>
  JSON.stringify({
    created: message.time.created,
    completed: message.time.completed ?? null,
    structured: message.structured ?? null,
    error: message.error ?? null,
  })

const requireContract = (claim: ResumeClaim, options: OpenCodeResumeWorkerOptions) => {
  const contract = options.contracts.find(
    (candidate) =>
      candidate.name === claim.outputContract && candidate.version === claim.outputContractVersion,
  )
  return contract === undefined
    ? Effect.fail(
        new OpenCodeResumeWorkerError({
          operation: "select trusted output contract",
          cause: new Error("unsupported output contract"),
        }),
      )
    : Effect.succeed(contract)
}

const findContract = (
  name: string | null,
  version: number | null,
  options: OpenCodeResumeWorkerOptions,
) => options.contracts.find((candidate) => candidate.name === name && candidate.version === version)

const validateCustody = (
  claim: { readonly sessionId: string },
  options: OpenCodeResumeWorkerOptions,
) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const sessionUnknown = yield* store.readSession(claim.sessionId)
    const session = yield* Schema.decodeUnknown(SessionRow)(sessionUnknown).pipe(
      Effect.mapError(
        (cause) => new OpenCodeResumeWorkerError({ operation: "decode saved session", cause }),
      ),
    )
    const validSession =
      session.provider_kind === "opencode" &&
      session.provider_version === options.providerVersion &&
      session.provider_id === options.providerId &&
      session.server_id === options.serverId &&
      session.owning_host_id === options.owningHostId &&
      session.endpoint_alias === options.endpointAlias &&
      session.endpoint_identity === options.endpointIdentity &&
      session.session_id === claim.sessionId &&
      session.native_session_id.length > 0
    if (!validSession) {
      return yield* new OpenCodeResumeWorkerError({
        operation: "validate saved session custody",
        cause: new Error("saved session does not match this OpenCode worker"),
      })
    }
    const resourceUnknown = yield* store.readResource(session.resource_id)
    const resource = yield* Schema.decodeUnknown(ResourceRow)(resourceUnknown).pipe(
      Effect.mapError(
        (cause) => new OpenCodeResumeWorkerError({ operation: "decode saved resource", cause }),
      ),
    )
    if (
      resource.resource_id !== session.resource_id ||
      resource.owning_host_id !== options.owningHostId ||
      resource.state !== "reserved"
    ) {
      return yield* new OpenCodeResumeWorkerError({
        operation: "validate saved resource custody",
        cause: new Error("saved resource is not available to this worker"),
      })
    }
    const directory = yield* Effect.tryPromise({
      try: () => stat(resource.absolute_path),
      catch: (cause) =>
        new OpenCodeResumeWorkerError({ operation: "validate saved working directory", cause }),
    })
    if (!directory.isDirectory()) {
      return yield* new OpenCodeResumeWorkerError({
        operation: "validate saved working directory",
        cause: new Error("saved working path is not a directory"),
      })
    }
    return { directory: resource.absolute_path, nativeSessionId: session.native_session_id }
  })

const waitForAnswer = (events: AsyncIterable<OpenCodeSessionEvent>, sessionID: string) =>
  providerCall("observe OpenCode session events", async () => {
    for await (const event of events) {
      if (
        event.type === "message.updated" &&
        event.sessionID === sessionID &&
        event.message.time.completed !== undefined &&
        (event.message.structured !== undefined || event.message.error !== undefined)
      ) {
        if (event.message.error !== undefined) throw new Error("OpenCode session failed")
        return event.message.structured
      }
    }
    throw new Error("OpenCode event stream ended before completion")
  })

const recordObservation = (
  request: typeof ObservationRequestRow.Type,
  options: OpenCodeResumeWorkerOptions,
  disposition: "completed" | "missing" | "operator_required",
  evidence: unknown,
  resultVersion?: number,
) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const sql = yield* SqlClient.SqlClient
    const observedAt = options.now()
    yield* Effect.gen(function* () {
      yield* store.observeResume({
        requestId: request.request_id,
        attempt: request.attempt,
        observationId: `${request.request_id}:${request.attempt}:opencode-observation`,
        observerHostId: options.owningHostId,
        observerWorkerId: options.workerId,
        observerToken: randomUUID(),
        disposition,
        evidenceVersion: 1,
        evidence,
        observedAt,
      })
      if (disposition === "completed" && resultVersion !== undefined) {
        const completed = yield* Schema.decodeUnknown(CompletedObservationEvidence)(evidence)
        yield* sql`INSERT INTO kernel_resume_results (result_id, request_id, attempt, result_version,
          result_json, completed_at) VALUES (${`${request.request_id}:result`}, ${request.request_id},
          ${request.attempt}, ${resultVersion}, ${canonicalJson(completed.result)}, ${observedAt.toISOString()})`
      }
    }).pipe(sql.withTransaction)
    return { status: disposition, requestId: request.request_id }
  })

const observeRestartedResume = (options: OpenCodeResumeWorkerOptions) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const sql = yield* SqlClient.SqlClient
    const provider = yield* OpenCodeResumeProvider
    const recoverable = yield* store.readRecoverableResume(options.owningHostId)
    const candidate = recoverable.find((row) => row.state === "observation_required")
    if (candidate === undefined) return null
    const request = yield* Schema.decodeUnknown(ObservationRequestRow)(candidate).pipe(
      Effect.mapError(
        (cause) => new OpenCodeResumeWorkerError({ operation: "decode observed request", cause }),
      ),
    )
    if (request.owning_host_id !== options.owningHostId) return null
    const contract = findContract(request.output_contract, request.output_contract_version, options)
    if (contract === undefined) {
      return yield* recordObservation(request, options, "operator_required", {
        reason: "unsupported_output_contract",
      })
    }
    const custody = yield* validateCustody({ sessionId: request.session_id }, options).pipe(
      Effect.either,
    )
    if (custody._tag === "Left") {
      return yield* recordObservation(request, options, "operator_required", {
        reason: "invalid_saved_custody",
      })
    }
    const checkpointRows = yield* sql<{ readonly checkpoint_json: string }>`SELECT checkpoint_json
      FROM kernel_resume_checkpoints WHERE request_id = ${request.request_id}
        AND attempt = ${request.attempt} AND checkpoint_version = 1
      ORDER BY created_at DESC LIMIT 1`
    const checkpoint = yield* Schema.decodeUnknown(Schema.parseJson(BaselineCheckpoint))(
      checkpointRows[0]?.checkpoint_json,
    ).pipe(Effect.either)
    if (checkpoint._tag === "Left" || checkpoint.right.messages.length > MAX_BASELINE_MESSAGES) {
      return yield* recordObservation(request, options, "operator_required", {
        reason: "missing_or_malformed_baseline",
      })
    }
    const reference = {
      sessionID: custody.right.nativeSessionId,
      directory: custody.right.directory,
    }
    const exists = yield* providerCall("inspect OpenCode session after restart", (signal) =>
      provider.sessionExists(reference, signal),
    )
    if (!exists) {
      return yield* recordObservation(request, options, "missing", {
        reason: "provider_session_missing",
      })
    }
    const messages = yield* providerCall("inspect OpenCode history after restart", (signal) =>
      provider.listMessages(reference, signal),
    )
    if (messages.length > MAX_BASELINE_MESSAGES) {
      return yield* recordObservation(request, options, "operator_required", {
        reason: "history_exceeds_bound",
      })
    }
    const baseline = new Set(checkpoint.right.messages)
    const answers = messages.filter(
      (message) =>
        message.time.completed !== undefined &&
        message.structured !== undefined &&
        !baseline.has(fingerprint(message)),
    )
    if (answers.length !== 1) {
      return yield* recordObservation(request, options, "operator_required", {
        reason: answers.length === 0 ? "no_attributable_answer" : "ambiguous_answers",
        candidateCount: answers.length,
      })
    }
    const decoded = yield* Schema.decodeUnknown(
      boundedAgentPayload(contract.maxOutputBytes, "OpenCode resume output"),
    )(answers[0]!.structured).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(contract.schema)(value)),
      Effect.flatMap((value) => Schema.decodeUnknown(JsonValueSchema)(value)),
      Effect.either,
    )
    if (decoded._tag === "Left") {
      return yield* recordObservation(request, options, "operator_required", {
        reason: "malformed_attributable_answer",
      })
    }
    return yield* recordObservation(
      request,
      options,
      "completed",
      {
        reason: "uniquely_attributed_answer",
        result: decoded.right,
      },
      contract.version,
    )
  })

export const runOpenCodeResumeIteration = (options: OpenCodeResumeWorkerOptions) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const sql = yield* SqlClient.SqlClient
    const provider = yield* OpenCodeResumeProvider
    yield* store.recoverExpiredResume({ owningHostId: options.owningHostId, now: options.now() })
    const claim = yield* store.claimResume({
      owningHostId: options.owningHostId,
      workerId: options.workerId,
      now: options.now(),
      leaseDurationMs: options.leaseDurationMs,
    })
    if (claim === null) {
      return (yield* observeRestartedResume(options)) ?? { status: "idle" as const }
    }

    const prepared = yield* Effect.all([
      requireContract(claim, options),
      validateCustody(claim, options),
    ]).pipe(Effect.either)
    if (prepared._tag === "Left") {
      const failedAt = options.now()
      const changed = yield* sql`UPDATE kernel_resume_attempts SET state = 'operator_required',
        sent_at = ${failedAt.toISOString()}, updated_at = ${failedAt.toISOString()}
        WHERE request_id = ${claim.requestId} AND attempt = ${claim.attempt}
          AND owning_host_id = ${claim.owningHostId} AND worker_id = ${claim.workerId}
          AND claim_token = ${claim.claimToken} AND lease_until = ${claim.leaseUntil.toISOString()}
          AND lease_until > ${failedAt.toISOString()} AND state = 'leased' RETURNING request_id`
      if (changed.length === 0) return yield* prepared.left
      yield* sql`UPDATE kernel_resume_requests SET state = 'operator_required',
        updated_at = ${failedAt.toISOString()} WHERE request_id = ${claim.requestId} AND state = 'leased'`
      yield* sql`UPDATE kernel_sessions SET state = 'operator_required', revision = revision + 1,
        updated_at = ${failedAt.toISOString()} WHERE session_id = ${claim.sessionId}`
      return { status: "operator_required" as const, requestId: claim.requestId }
    }
    const [contract, custody] = prepared.right
    const reference = { sessionID: custody.nativeSessionId, directory: custody.directory }
    const exists = yield* providerCall("inspect OpenCode session", (signal) =>
      provider.sessionExists(reference, signal),
    )
    if (!exists) {
      const missingAt = options.now()
      const changed = yield* sql`UPDATE kernel_resume_attempts SET state = 'failed',
        sent_at = ${missingAt.toISOString()}, updated_at = ${missingAt.toISOString()}
        WHERE request_id = ${claim.requestId} AND attempt = ${claim.attempt}
          AND owning_host_id = ${claim.owningHostId} AND worker_id = ${claim.workerId}
          AND claim_token = ${claim.claimToken} AND lease_until = ${claim.leaseUntil.toISOString()}
          AND lease_until > ${missingAt.toISOString()} AND state = 'leased' RETURNING request_id`
      if (changed.length === 0) {
        return yield* new OpenCodeResumeWorkerError({
          operation: "record missing OpenCode session",
          cause: new Error("resume authority was lost"),
        })
      }
      yield* sql`UPDATE kernel_resume_requests SET state = 'failed', updated_at = ${missingAt.toISOString()}
        WHERE request_id = ${claim.requestId} AND state = 'leased'`
      yield* sql`UPDATE kernel_sessions SET state = 'missing', revision = revision + 1,
        updated_at = ${missingAt.toISOString()} WHERE session_id = ${claim.sessionId}`
      return { status: "missing" as const, requestId: claim.requestId }
    }
    const baseline = yield* providerCall("capture OpenCode message baseline", (signal) =>
      provider.listMessages(reference, signal),
    )
    if (baseline.length > MAX_BASELINE_MESSAGES) {
      return yield* new OpenCodeResumeWorkerError({
        operation: "capture OpenCode message baseline",
        cause: new Error("OpenCode message baseline exceeds its bound"),
      })
    }
    const beforeSent = options.now()
    yield* store.checkpointResume({
      ...authority(claim, beforeSent),
      checkpointId: `${claim.requestId}:${claim.attempt}:opencode-baseline`,
      checkpointVersion: 1,
      checkpoint: { messages: baseline.map(fingerprint) },
    })
    yield* store.markResumeSent(authority(claim, options.now()))
    const observationController = new AbortController()
    let leaseUntil = claim.leaseUntil
    const heartbeat = Effect.forever(
      Effect.sleep(options.heartbeatIntervalMs).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const heartbeatAt = options.now()
            const nextLease = new Date(heartbeatAt.getTime() + options.leaseDurationMs)
            const rows = yield* sql`UPDATE kernel_resume_attempts
              SET lease_until = ${nextLease.toISOString()}, updated_at = ${heartbeatAt.toISOString()}
              WHERE request_id = ${claim.requestId} AND attempt = ${claim.attempt}
                AND owning_host_id = ${claim.owningHostId} AND worker_id = ${claim.workerId}
                AND claim_token = ${claim.claimToken} AND lease_until = ${leaseUntil.toISOString()}
                AND lease_until > ${heartbeatAt.toISOString()} AND state = 'sent'
              RETURNING request_id`
            if (rows.length === 0) {
              return yield* new OpenCodeResumeWorkerError({
                operation: "heartbeat sent resume claim",
                cause: new Error("resume authority was lost"),
              })
            }
            leaseUntil = nextLease
          }),
        ),
      ),
    )
    const encoded = yield* Effect.raceFirst(
      Effect.gen(function* () {
        const events = yield* providerCall("subscribe to OpenCode session events", () =>
          provider.subscribeEvents({ directory: custody.directory }, observationController.signal),
        )
        yield* providerCall("send saved OpenCode prompt", (signal) =>
          provider.promptAsync(
            {
              ...reference,
              prompt: claim.promptText,
              agent: contract.agent,
              model: contract.model,
              jsonSchema: contract.jsonSchema,
            },
            signal,
          ),
        )
        return yield* waitForAnswer(events, custody.nativeSessionId)
      }),
      heartbeat,
    ).pipe(Effect.ensuring(Effect.sync(() => observationController.abort())))
    const result = yield* Schema.decodeUnknown(
      boundedAgentPayload(contract.maxOutputBytes, "OpenCode resume output"),
    )(encoded).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(contract.schema)(value)),
      Effect.flatMap((value) => Schema.decodeUnknown(JsonValueSchema)(value)),
    )
    yield* store.completeResume({
      ...sentAuthority(claim, leaseUntil, options.now()),
      resultId: `${claim.requestId}:result`,
      resultVersion: contract.version,
      result,
    })
    return { status: "completed" as const, requestId: claim.requestId }
  })
