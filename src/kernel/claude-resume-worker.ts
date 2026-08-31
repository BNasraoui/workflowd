import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Schema } from "effect"
import { boundedAgentPayload } from "../agent-payload"
import { JsonValueSchema } from "../json"
import { structuredExtractionPrompt } from "../opencode/adapter"
import { ClaudeCli, claudeHostFromEndpointIdentity } from "./claude-session"
import { KernelSessionStore, type KernelSessionStoreError, type ResumeClaim } from "./session-store"

/**
 * Delivers wakes to Claude Code sessions, closing the loop for Claude
 * dispatchers the way the OpenCode resume worker does for opencode ones.
 * Delivery is two `claude -p --resume` turns: the canonical resume prompt,
 * then the schema-bearing extraction prompt whose reply must be the trusted
 * structured acknowledgment. The claude CLI (subscription auth) is the only
 * channel — never provider routing.
 *
 * v1 scope: sessions owned by this daemon's host. A crash between the
 * durable sent fence and completion cannot be re-attributed from a CLI
 * transcript, so restart recovery escalates to operator_required rather
 * than guessing.
 */
export type ClaudeResumeContract = {
  readonly name: string
  readonly version: number
  readonly schema: Schema.Codec<unknown, unknown>
  readonly jsonSchema: object
  readonly maxOutputBytes: number
}

export type ClaudeResumeWorkerOptions = {
  readonly owningHostId: string
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly resumeTimeoutMs: number
  readonly retryDelayMs: number
  readonly now: () => Date
  readonly contracts: ReadonlyArray<ClaudeResumeContract>
}

export class ClaudeResumeWorkerError extends Data.TaggedError("ClaudeResumeWorkerError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export type ClaudeResumeWorkerPort = {
  readonly iteration: Effect.Effect<
    "idle" | "completed" | "operator_required" | "retry_scheduled",
    ClaudeResumeWorkerError | KernelSessionStoreError | SqlError | Schema.SchemaError
  >
}

export const ClaudeResumeWorker = Context.Service<ClaudeResumeWorkerPort>(
  "workflowd/kernel/ClaudeResumeWorker",
)

const SessionRow = Schema.Struct({
  session_id: Schema.String,
  provider_kind: Schema.Literals(["opencode", "codex", "claude"]),
  owning_host_id: Schema.String,
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

const CliAnswer = Schema.Struct({ result: Schema.String })

const authorityOf = (claim: ResumeClaim, now: Date) => ({
  requestId: claim.requestId,
  attempt: claim.attempt,
  owningHostId: claim.owningHostId,
  workerId: claim.workerId,
  claimToken: claim.claimToken,
  expectedLeaseUntil: claim.leaseUntil,
  now,
})

const parseCliAnswer = (stdout: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(CliAnswer))(stdout.trim()).pipe(
    Effect.map((decoded) => decoded.result),
  )

const parseStructured = (text: string) => {
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```[a-zA-Z]*\r?\n/, "")
        .replace(/\r?\n```$/, "")
        .trim()
    : trimmed
  return Schema.decodeUnknownEffect(Schema.fromJsonString(JsonValueSchema))(unfenced)
}

const validateCustody = (sessionId: string, options: ClaudeResumeWorkerOptions) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const cli = yield* ClaudeCli
    const sessionUnknown = yield* store.readSession(sessionId)
    const session = yield* Schema.decodeUnknownEffect(SessionRow)(sessionUnknown ?? {})
    // The endpoint identity names the host the transcript lives on; the
    // daemon still owns the resume lifecycle, delivery just routes there.
    const deliveryHost = claudeHostFromEndpointIdentity(session.endpoint_identity)
    if (
      session.provider_kind !== "claude" ||
      session.owning_host_id !== options.owningHostId ||
      deliveryHost === null ||
      !cli.hosts.includes(deliveryHost)
    ) {
      return yield* Effect.fail(
        new ClaudeResumeWorkerError({
          operation: "validate saved claude session custody",
          cause: new Error("saved session is not a claude session this worker can deliver to"),
        }),
      )
    }
    const resourceUnknown = yield* store.readResource(session.resource_id)
    const resource = yield* Schema.decodeUnknownEffect(ResourceRow)(resourceUnknown ?? {})
    if (resource.state !== "reserved" || resource.owning_host_id !== options.owningHostId) {
      return yield* Effect.fail(
        new ClaudeResumeWorkerError({
          operation: "validate saved claude resource custody",
          cause: new Error("saved resource is not available to this worker"),
        }),
      )
    }
    const exists = yield* cli
      .sessionExists({
        nativeSessionId: session.native_session_id,
        directory: resource.absolute_path,
        host: deliveryHost,
      })
      .pipe(
        Effect.mapError(
          (cause) => new ClaudeResumeWorkerError({ operation: "probe claude session", cause }),
        ),
      )
    if (!exists) {
      return yield* Effect.fail(
        new ClaudeResumeWorkerError({
          operation: "probe claude session",
          cause: new Error("claude session transcript does not exist for this directory"),
        }),
      )
    }
    return {
      directory: resource.absolute_path,
      nativeSessionId: session.native_session_id,
      host: deliveryHost,
    }
  })

const operatorRequired = (claim: ResumeClaim, options: ClaudeResumeWorkerOptions, reason: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const at = options.now()
    const changed = yield* sql`UPDATE kernel_resume_attempts SET state = 'operator_required',
      sent_at = COALESCE(sent_at, ${at.toISOString()}), updated_at = ${at.toISOString()}
      WHERE request_id = ${claim.requestId} AND attempt = ${claim.attempt}
        AND owning_host_id = ${claim.owningHostId} AND worker_id = ${claim.workerId}
        AND claim_token = ${claim.claimToken} AND lease_until = ${claim.leaseUntil.toISOString()}
        AND state IN ('leased', 'sent') RETURNING request_id`
    if (changed.length === 0) {
      return yield* Effect.fail(
        new ClaudeResumeWorkerError({
          operation: reason,
          cause: new Error("resume authority was lost"),
        }),
      )
    }
    yield* sql`UPDATE kernel_resume_requests SET state = 'operator_required',
      updated_at = ${at.toISOString()} WHERE request_id = ${claim.requestId}
      AND state IN ('leased', 'sent')`
    yield* sql`UPDATE kernel_sessions SET state = 'operator_required', revision = revision + 1,
      updated_at = ${at.toISOString()} WHERE session_id = ${claim.sessionId}`
    return { status: "operator_required" as const, requestId: claim.requestId, reason }
  })

/** Restart recovery: a claude wake interrupted after its durable sent fence
 * cannot be attributed from CLI output that no longer exists; escalate. */
const escalateRestartedClaudeResume = (options: ClaudeResumeWorkerOptions) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const sql = yield* SqlClient.SqlClient
    const recoverable = yield* store.readRecoverableResume(options.owningHostId)
    for (const row of recoverable) {
      if (row.state !== "observation_required") continue
      const sessionId = typeof row.session_id === "string" ? row.session_id : ""
      const requestId = typeof row.request_id === "string" ? row.request_id : ""
      if (sessionId.length === 0 || requestId.length === 0) continue
      const sessionUnknown = yield* store.readSession(sessionId)
      const kind =
        sessionUnknown !== null && typeof sessionUnknown.provider_kind === "string"
          ? sessionUnknown.provider_kind
          : ""
      if (kind !== "claude") continue
      const at = options.now()
      yield* sql`UPDATE kernel_resume_attempts SET state = 'operator_required',
        updated_at = ${at.toISOString()} WHERE request_id = ${requestId}
        AND state = 'observation_required'`
      yield* sql`UPDATE kernel_resume_requests SET state = 'operator_required',
        updated_at = ${at.toISOString()} WHERE request_id = ${requestId}
        AND state = 'observation_required'`
      return { status: "operator_required" as const, requestId, reason: "restart_unattributable" }
    }
    return null
  })

export const runClaudeResumeIteration = (options: ClaudeResumeWorkerOptions) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const cli = yield* ClaudeCli
    yield* store.recoverExpiredResume({ owningHostId: options.owningHostId, now: options.now() })
    const claim = yield* store.claimResume({
      owningHostId: options.owningHostId,
      workerId: options.workerId,
      now: options.now(),
      leaseDurationMs: options.leaseDurationMs,
      providerKind: "claude",
    })
    if (claim === null) {
      return (yield* escalateRestartedClaudeResume(options)) ?? { status: "idle" as const }
    }
    const contract = options.contracts.find(
      (candidate) =>
        candidate.name === claim.outputContract &&
        candidate.version === claim.outputContractVersion,
    )
    if (contract === undefined) {
      return yield* operatorRequired(claim, options, "unsupported_output_contract")
    }
    const custody = yield* validateCustody(claim.sessionId, options).pipe(Effect.result)
    if (custody._tag === "Failure") {
      return yield* operatorRequired(claim, options, "invalid_saved_custody")
    }
    const reference = custody.success
    yield* store.markResumeSent(authorityOf(claim, options.now()))

    const cliCall = (prompt: string) =>
      cli
        .resume({
          nativeSessionId: reference.nativeSessionId,
          directory: reference.directory,
          host: reference.host,
          prompt,
          timeoutMs: options.resumeTimeoutMs,
        })
        .pipe(Effect.flatMap(parseCliAnswer))
    const extractOnce = (feedback?: string) =>
      Effect.gen(function* () {
        const extracted = yield* cliCall(
          structuredExtractionPrompt(
            contract.jsonSchema,
            ...(feedback === undefined ? [] : [feedback]),
          ),
        )
        const structured = yield* parseStructured(extracted)
        const bounded = yield* Schema.decodeUnknownEffect(
          boundedAgentPayload(contract.maxOutputBytes, "claude resume output"),
        )(structured)
        const validated = yield* Schema.decodeUnknownEffect(contract.schema)(bounded)
        return yield* Schema.decodeUnknownEffect(JsonValueSchema)(validated)
      })
    const work = Effect.gen(function* () {
      yield* cliCall(claim.promptText)
      // One bounded extraction retry with feedback; the wake itself is
      // never re-sent, so the session sees at most one duplicate request
      // for structure, not a duplicate task.
      return yield* extractOnce().pipe(
        Effect.catch(() =>
          extractOnce("The previous reply was not a single JSON value matching the schema."),
        ),
      )
    })
    const heartbeat = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(options.heartbeatIntervalMs)
        yield* store.heartbeatResume({
          ...authorityOf(claim, options.now()),
          leaseDurationMs: options.leaseDurationMs,
        })
      }
    })
    const answered = yield* Effect.raceFirst(work, heartbeat).pipe(Effect.result)
    if (answered._tag === "Failure") {
      // The durable sent fence already stands, so the wake may have reached
      // the session; a redelivery cannot be attributed afterwards. Escalate
      // rather than guess.
      return yield* operatorRequired(claim, options, "delivery_failed")
    }
    yield* store.completeResume({
      ...authorityOf(claim, options.now()),
      resultId: `${claim.requestId}:result`,
      resultVersion: contract.version,
      result: answered.success,
    })
    return { status: "completed" as const, requestId: claim.requestId }
  })
