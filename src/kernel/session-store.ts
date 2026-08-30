import { createHash, randomUUID } from "node:crypto"
import { posix } from "node:path"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { JsonValueSchema } from "../json"
import type {
  CleanupAuthority,
  CleanupClaim,
  ResumeAuthority,
  ResumeClaim,
} from "./session-store-model"
import {
  MAX_CUSTODY_ID_BYTES,
  MAX_CUSTODY_JSON_BYTES,
  MAX_CUSTODY_PATH_BYTES,
  MAX_CUSTODY_TEXT_BYTES,
} from "./session-store-model"
import {
  bytes,
  canonicalJson as canonical,
  checkTextValue,
  CleanupReadRow,
  JsonText,
  ObservationReadRow,
  positiveValue,
  ResourceReadRow,
  ResumeReadRow,
  SessionReadRow,
  Timestamp,
  validDateValue,
} from "./session-store-support"

export * from "./session-store-model"

export class KernelSessionStoreInputError extends Data.TaggedError("KernelSessionStoreInputError")<{
  readonly message: string
}> {}
export class KernelSessionStoreConflictError extends Data.TaggedError(
  "KernelSessionStoreConflictError",
)<{
  readonly record: string
  readonly key: string
}> {}
export class KernelSessionStoreAuthorityError extends Data.TaggedError(
  "KernelSessionStoreAuthorityError",
)<{
  readonly key: string
}> {}
export class KernelSessionStoreDataError extends Data.TaggedError("KernelSessionStoreDataError")<{
  readonly record: string
  readonly key: string
  readonly message: string
}> {}
export type KernelSessionStoreError =
  | SqlError
  | KernelSessionStoreInputError
  | KernelSessionStoreConflictError
  | KernelSessionStoreAuthorityError
  | KernelSessionStoreDataError

type ClaimInput = {
  readonly owningHostId: string
  readonly workerId: string
  readonly now: Date
  readonly leaseDurationMs: number
}
type Replay = Effect.Effect<{ readonly status: "created" | "duplicate" }, KernelSessionStoreError>

export type KernelSessionStorePort = {
  readonly registerResource: (input: {
    readonly resourceId: string
    readonly owningHostId: string
    readonly absolutePath: string
    readonly kind: "workspace" | "worktree" | "checkout"
    readonly createdAt: Date
  }) => Replay
  readonly registerSession: (input: {
    readonly sessionId: string
    readonly providerKind: "opencode" | "codex" | "claude"
    readonly providerVersion: number
    readonly providerId: string
    readonly serverId: string
    readonly owningHostId: string
    readonly endpointAlias: string
    readonly endpointIdentity: string
    readonly nativeSessionId: string
    readonly resourceId: string
    readonly createdAt: Date
  }) => Replay
  readonly registerResumeRequest: (input: {
    readonly requestId: string
    readonly sessionId: string
    readonly owningHostId: string
    readonly prompt: unknown
    readonly promptText: string
    readonly promptSha256: string
    readonly outputContract: string | null
    readonly outputContractVersion: number | null
    readonly maxAttempts: number
    readonly runAt: Date
    readonly createdAt: Date
  }) => Replay
  readonly claimResume: (
    input: ClaimInput,
  ) => Effect.Effect<ResumeClaim | null, KernelSessionStoreError>
  readonly heartbeatResume: (
    input: ResumeAuthority & { readonly leaseDurationMs: number },
  ) => Effect.Effect<{ readonly leaseUntil: Date }, KernelSessionStoreError>
  readonly markResumeSent: (input: ResumeAuthority) => Effect.Effect<void, KernelSessionStoreError>
  readonly checkpointResume: (
    input: ResumeAuthority & {
      readonly checkpointId: string
      readonly checkpointVersion: number
      readonly checkpoint: unknown
    },
  ) => Replay
  readonly completeResume: (
    input: ResumeAuthority & {
      readonly resultId: string
      readonly resultVersion: number
      readonly result: unknown
    },
  ) => Effect.Effect<{ readonly status: "completed" | "duplicate" }, KernelSessionStoreError>
  readonly failResume: (input: ResumeAuthority) => Effect.Effect<void, KernelSessionStoreError>
  readonly cancelResume: (input: ResumeAuthority) => Effect.Effect<void, KernelSessionStoreError>
  readonly releaseResume: (
    input: ResumeAuthority & { readonly runAt: Date },
  ) => Effect.Effect<void, KernelSessionStoreError>
  readonly recoverExpiredResume: (input: {
    readonly owningHostId: string
    readonly now: Date
  }) => Effect.Effect<number, KernelSessionStoreError>
  readonly observeResume: (input: {
    readonly requestId: string
    readonly attempt: number
    readonly observationId: string
    readonly observerHostId: string
    readonly observerWorkerId: string
    readonly observerToken: string
    readonly disposition: "completed" | "missing" | "failed" | "operator_required"
    readonly evidenceVersion: number
    readonly evidence: unknown
    readonly observedAt: Date
  }) => Replay
  readonly requestCleanup: (input: {
    readonly cleanupId: string
    readonly resourceId: string
    readonly owningHostId: string
    readonly reason: string
    readonly maxAttempts: number
    readonly runAt: Date
    readonly createdAt: Date
  }) => Replay
  readonly claimCleanup: (
    input: ClaimInput,
  ) => Effect.Effect<CleanupClaim | null, KernelSessionStoreError>
  readonly heartbeatCleanup: (
    input: CleanupAuthority & { readonly leaseDurationMs: number },
  ) => Effect.Effect<{ readonly leaseUntil: Date }, KernelSessionStoreError>
  readonly completeCleanup: (
    input: CleanupAuthority & {
      readonly outcomeId: string
      readonly disposition: "completed" | "missing" | "retry" | "operator_required"
      readonly outcomeVersion: number
      readonly outcome: unknown
      readonly runAt?: Date
    },
  ) => Effect.Effect<{ readonly status: "completed" | "duplicate" }, KernelSessionStoreError>
  readonly readResource: (
    id: string,
  ) => Effect.Effect<Record<string, unknown> | null, KernelSessionStoreError>
  readonly readSession: (
    id: string,
  ) => Effect.Effect<Record<string, unknown> | null, KernelSessionStoreError>
  readonly readResumeRequest: (
    id: string,
  ) => Effect.Effect<Record<string, unknown> | null, KernelSessionStoreError>
  readonly readLatestObservation: (
    id: string,
  ) => Effect.Effect<Record<string, unknown> | null, KernelSessionStoreError>
  readonly readResumeResult: (
    id: string,
  ) => Effect.Effect<Record<string, unknown> | null, KernelSessionStoreError>
  readonly readRecoverableResume: (
    host: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, KernelSessionStoreError>
  readonly readRecoverableCleanup: (
    host: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, KernelSessionStoreError>
}

export const KernelSessionStore = Context.Service<KernelSessionStorePort>(
  "workflowd/kernel/KernelSessionStore",
)
const inputError = (message: string) => new KernelSessionStoreInputError({ message })
const checkText = (value: string, max = MAX_CUSTODY_ID_BYTES) =>
  checkTextValue(value, max)
    ? Effect.succeed(value)
    : Effect.fail(inputError(`text must be 1..${max} UTF-8 bytes`))
const positive = (value: number) =>
  positiveValue(value)
    ? Effect.succeed(value)
    : Effect.fail(inputError("must be a positive integer"))
const validDate = (value: Date) =>
  validDateValue(value) ? Effect.succeed(value) : Effect.fail(inputError("date must be valid"))
const leaseDeadline = (now: Date, durationMs: number) =>
  validDate(new Date(now.getTime() + durationMs))
const boundedJson = (value: unknown) =>
  Schema.decodeUnknownEffect(JsonValueSchema)(value).pipe(
    Effect.mapError((error) => inputError(String(error))),
    Effect.flatMap((decoded) => {
      const json = canonical(decoded)
      return bytes(json) <= MAX_CUSTODY_JSON_BYTES
        ? Effect.succeed({ decoded, json })
        : Effect.fail(inputError("JSON exceeds 65536 UTF-8 bytes"))
    }),
  )
const conflict = (record: string, key: string) =>
  new KernelSessionStoreConflictError({ record, key })
const denied = (key: string) => new KernelSessionStoreAuthorityError({ key })
type CleanupDisposition = "completed" | "missing" | "retry" | "operator_required"
type CleanupTerminalState = "cleaned" | "missing" | "operator_required" | "cleanup_required"
const observationState = (
  disposition: "completed" | "missing" | "failed" | "operator_required",
) => {
  if (disposition === "completed") return "completed" as const
  if (disposition === "operator_required") return "operator_required" as const
  return "failed" as const
}
const effectiveCleanupDisposition = (
  input: CleanupDisposition,
  attempt: number,
  maxAttempts: number,
) => {
  if (input === "retry" && attempt >= maxAttempts) return "operator_required" as const
  return input
}
const cleanupTerminalState = (disposition: CleanupDisposition): CleanupTerminalState => {
  if (disposition === "completed") return "cleaned"
  if (disposition === "missing") return "missing"
  if (disposition === "operator_required") return "operator_required"
  return "cleanup_required"
}
const cleanupRequestState = (disposition: CleanupDisposition) =>
  disposition === "retry" ? ("retry_scheduled" as const) : disposition
const cleanupError = (disposition: CleanupDisposition, payload: string) =>
  disposition === "operator_required" ? payload : null
const validateResumeAuthority = (input: ResumeAuthority) =>
  Effect.all([validDate(input.expectedLeaseUntil), validDate(input.now)])
const validateCleanupAuthority = (input: CleanupAuthority) =>
  Effect.all([validDate(input.expectedLeaseUntil), validDate(input.now)])
const dataError = (record: string, key: string) => (error: unknown) =>
  new KernelSessionStoreDataError({ record, key, message: String(error) })
const decodeRead = (
  schema: Schema.Codec<any, any>,
  record: string,
  key: string,
  row: Record<string, unknown>,
) =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError(dataError(record, key)),
    Effect.as(row),
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA busy_timeout = 5000`

  const registerResource: KernelSessionStorePort["registerResource"] = (input) =>
    Effect.gen(function* () {
      yield* checkText(input.resourceId)
      yield* checkText(input.owningHostId)
      yield* validDate(input.createdAt)
      if (
        input.absolutePath.length === 0 ||
        bytes(input.absolutePath) > MAX_CUSTODY_PATH_BYTES ||
        !posix.isAbsolute(input.absolutePath) ||
        posix.normalize(input.absolutePath) !== input.absolutePath ||
        input.absolutePath.includes("//") ||
        (input.absolutePath !== "/" && input.absolutePath.endsWith("/"))
      ) {
        return yield* inputError("path must be absolute and lexically normalized")
      }
      const existing =
        yield* sql`SELECT * FROM kernel_working_resources WHERE resource_id = ${input.resourceId}`
      if (existing.length > 0) {
        const row = existing[0]!
        if (
          row.owning_host_id === input.owningHostId &&
          row.absolute_path === input.absolutePath &&
          row.kind === input.kind &&
          row.created_at === input.createdAt.toISOString()
        )
          return { status: "duplicate" as const }
        return yield* conflict("resource", input.resourceId)
      }
      const inserted =
        yield* sql`INSERT INTO kernel_working_resources (resource_id, owning_host_id, absolute_path,
      kind, state, created_at, updated_at) VALUES (${input.resourceId}, ${input.owningHostId},
      ${input.absolutePath}, ${input.kind}, 'reserved', ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()})
      ON CONFLICT DO NOTHING RETURNING resource_id`
      if (inserted.length === 0) {
        const raced =
          yield* sql`SELECT * FROM kernel_working_resources WHERE resource_id = ${input.resourceId}`
        const row = raced[0]
        if (
          row?.owning_host_id === input.owningHostId &&
          row.absolute_path === input.absolutePath &&
          row.kind === input.kind &&
          row.created_at === input.createdAt.toISOString()
        )
          return { status: "duplicate" as const }
        return yield* conflict("resource", input.resourceId)
      }
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  const registerSession: KernelSessionStorePort["registerSession"] = (input) =>
    Effect.gen(function* () {
      for (const text of [
        input.sessionId,
        input.providerId,
        input.serverId,
        input.owningHostId,
        input.endpointAlias,
        input.nativeSessionId,
        input.resourceId,
      ])
        yield* checkText(text)
      yield* checkText(input.endpointIdentity, 512)
      yield* positive(input.providerVersion)
      yield* validDate(input.createdAt)
      const existing =
        yield* sql`SELECT * FROM kernel_sessions WHERE session_id = ${input.sessionId}`
      if (existing.length > 0) {
        const row = existing[0]!
        const exact =
          row.provider_kind === input.providerKind &&
          row.provider_version === input.providerVersion &&
          row.provider_id === input.providerId &&
          row.server_id === input.serverId &&
          row.owning_host_id === input.owningHostId &&
          row.endpoint_alias === input.endpointAlias &&
          row.endpoint_identity === input.endpointIdentity &&
          row.native_session_id === input.nativeSessionId &&
          row.resource_id === input.resourceId &&
          row.created_at === input.createdAt.toISOString()
        if (exact) return { status: "duplicate" as const }
        return yield* conflict("session", input.sessionId)
      }
      const resource =
        yield* sql`SELECT state FROM kernel_working_resources WHERE resource_id = ${input.resourceId}
      AND owning_host_id = ${input.owningHostId}`
      if (resource[0]?.state !== "reserved") return yield* conflict("resource", input.resourceId)
      const cleanup =
        yield* sql`SELECT cleanup_id FROM kernel_cleanup_requests WHERE resource_id = ${input.resourceId}
      AND state IN ('pending', 'leased', 'retry_scheduled', 'operator_required')`
      if (cleanup.length > 0) return yield* conflict("cleanup", input.resourceId)
      const inserted =
        yield* sql`INSERT INTO kernel_sessions (session_id, provider_kind, provider_version, provider_id,
      server_id, owning_host_id, endpoint_alias, endpoint_identity, native_session_id, resource_id,
      state, revision, created_at, updated_at) VALUES (${input.sessionId}, ${input.providerKind},
      ${input.providerVersion}, ${input.providerId}, ${input.serverId}, ${input.owningHostId},
      ${input.endpointAlias}, ${input.endpointIdentity}, ${input.nativeSessionId}, ${input.resourceId},
      'ready', 1, ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()})
      ON CONFLICT DO NOTHING RETURNING session_id`
      if (inserted.length === 0) {
        const raced =
          yield* sql`SELECT * FROM kernel_sessions WHERE session_id = ${input.sessionId}`
        const row = raced[0]
        if (
          row?.provider_kind === input.providerKind &&
          row.provider_version === input.providerVersion &&
          row.provider_id === input.providerId &&
          row.server_id === input.serverId &&
          row.owning_host_id === input.owningHostId &&
          row.endpoint_alias === input.endpointAlias &&
          row.endpoint_identity === input.endpointIdentity &&
          row.native_session_id === input.nativeSessionId &&
          row.resource_id === input.resourceId &&
          row.created_at === input.createdAt.toISOString()
        )
          return { status: "duplicate" as const }
        return yield* conflict("session", input.sessionId)
      }
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  const registerResumeRequest: KernelSessionStorePort["registerResumeRequest"] = (input) =>
    Effect.gen(function* () {
      for (const text of [input.requestId, input.sessionId, input.owningHostId])
        yield* checkText(text)
      yield* checkText(input.promptText, MAX_CUSTODY_TEXT_BYTES)
      yield* positive(input.maxAttempts)
      yield* validDate(input.runAt)
      yield* validDate(input.createdAt)
      const payload = yield* boundedJson(input.prompt)
      const hash = createHash("sha256").update(input.promptText).digest("hex")
      if (hash !== input.promptSha256 || canonical(payload.decoded) !== input.promptText)
        return yield* inputError("prompt hash/text mismatch")
      if ((input.outputContract === null) !== (input.outputContractVersion === null))
        return yield* inputError("output contract pair required")
      if (input.outputContract !== null) {
        yield* checkText(input.outputContract)
        yield* positive(input.outputContractVersion!)
      }
      const existing =
        yield* sql`SELECT * FROM kernel_resume_requests WHERE request_id = ${input.requestId}`
      if (existing.length > 0) {
        const row = existing[0]!
        if (
          row.session_id === input.sessionId &&
          row.owning_host_id === input.owningHostId &&
          row.prompt_json === payload.json &&
          row.prompt_text === input.promptText &&
          row.prompt_sha256 === hash &&
          row.output_contract === input.outputContract &&
          row.output_contract_version === input.outputContractVersion &&
          row.max_attempts === input.maxAttempts &&
          row.run_at === input.runAt.toISOString() &&
          row.created_at === input.createdAt.toISOString()
        )
          return { status: "duplicate" as const }
        return yield* conflict("resume_request", input.requestId)
      }
      const session = yield* sql`SELECT session.resource_id FROM kernel_sessions AS session
      JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
      WHERE session.session_id = ${input.sessionId} AND session.owning_host_id = ${input.owningHostId}
        AND session.state IN ('ready', 'active') AND resource.state = 'reserved'`
      if (session.length === 0) return yield* conflict("session", input.sessionId)
      const cleanup =
        yield* sql`SELECT cleanup_id FROM kernel_cleanup_requests WHERE resource_id = ${session[0]!.resource_id}
      AND state IN ('pending', 'leased', 'retry_scheduled', 'operator_required')`
      if (cleanup.length > 0) return yield* conflict("cleanup", input.sessionId)
      yield* sql`INSERT INTO kernel_resume_requests (request_id, session_id, owning_host_id, prompt_json,
      prompt_text, prompt_sha256, output_contract, output_contract_version, state, attempt, max_attempts,
      run_at, created_at, updated_at) VALUES (${input.requestId}, ${input.sessionId}, ${input.owningHostId},
      ${payload.json}, ${input.promptText}, ${hash}, ${input.outputContract}, ${input.outputContractVersion},
      'ready', 0, ${input.maxAttempts}, ${input.runAt.toISOString()}, ${input.createdAt.toISOString()},
      ${input.createdAt.toISOString()})`
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  const claimResume: KernelSessionStorePort["claimResume"] = (input) =>
    Effect.gen(function* () {
      yield* checkText(input.owningHostId)
      yield* checkText(input.workerId)
      const ms = yield* positive(input.leaseDurationMs)
      yield* validDate(input.now)
      const deadline = yield* leaseDeadline(input.now, ms)
      const nowText = input.now.toISOString()
      const exhausted =
        yield* sql`UPDATE kernel_resume_requests SET state = 'failed', updated_at = ${nowText}
        WHERE owning_host_id = ${input.owningHostId} AND state = 'leased' AND attempt >= max_attempts
          AND EXISTS (SELECT 1 FROM kernel_resume_attempts AS attempt_row
            WHERE attempt_row.request_id = kernel_resume_requests.request_id
              AND attempt_row.attempt = kernel_resume_requests.attempt
              AND attempt_row.state = 'leased' AND attempt_row.lease_until <= ${nowText})
        RETURNING session_id`
      for (const row of exhausted)
        yield* sql`UPDATE kernel_sessions SET state = 'operator_required',
        revision = revision + 1, updated_at = ${nowText} WHERE session_id = ${row.session_id}`
      yield* sql`UPDATE kernel_resume_attempts SET state = 'failed',
        sent_at = COALESCE(sent_at, ${nowText}), updated_at = ${nowText}
        WHERE owning_host_id = ${input.owningHostId} AND state = 'leased' AND lease_until <= ${nowText}
          AND EXISTS (SELECT 1 FROM kernel_resume_requests AS request
            WHERE request.request_id = kernel_resume_attempts.request_id
              AND request.attempt = kernel_resume_attempts.attempt AND request.state = 'failed')`
      const candidates = yield* sql`SELECT request.* FROM kernel_resume_requests AS request
      JOIN kernel_sessions AS session ON session.session_id = request.session_id
      JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
      WHERE request.owning_host_id = ${input.owningHostId} AND session.owning_host_id = ${input.owningHostId}
        AND ((request.state = 'ready' AND request.run_at <= ${nowText}) OR
          (request.state = 'leased' AND EXISTS (SELECT 1 FROM kernel_resume_attempts AS attempt_row
            WHERE attempt_row.request_id = request.request_id AND attempt_row.attempt = request.attempt
              AND attempt_row.state = 'leased' AND attempt_row.lease_until <= ${nowText})))
        AND resource.state = 'reserved' AND NOT EXISTS (SELECT 1 FROM kernel_cleanup_requests AS cleanup
          WHERE cleanup.resource_id = resource.resource_id AND cleanup.state IN ('pending', 'leased', 'retry_scheduled', 'operator_required'))
      ORDER BY request.run_at, request.request_id`
      for (const candidate of candidates) {
        const rowDecoded = yield* Schema.decodeUnknownEffect(ResumeReadRow)(candidate).pipe(
          Effect.result,
        )
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonValueSchema))(
          candidate.prompt_json,
        ).pipe(Effect.result)
        const valid =
          rowDecoded._tag === "Success" &&
          rowDecoded.success.attempt < rowDecoded.success.max_attempts &&
          decoded._tag === "Success" &&
          canonical(decoded.success) === candidate.prompt_text &&
          createHash("sha256").update(String(candidate.prompt_text)).digest("hex") ===
            candidate.prompt_sha256
        if (!valid) {
          yield* sql`UPDATE kernel_resume_requests SET state = 'data_error', updated_at = ${nowText}
          WHERE request_id = ${candidate.request_id} AND state IN ('ready', 'leased')`
          yield* sql`UPDATE kernel_resume_attempts SET state = 'data_error',
            sent_at = COALESCE(sent_at, ${nowText}), updated_at = ${nowText}
            WHERE request_id = ${candidate.request_id} AND attempt = ${candidate.attempt}
              AND state = 'leased'`
          continue
        }
        const token = randomUUID()
        const until = deadline
        const rows =
          yield* sql`UPDATE kernel_resume_requests SET state = 'leased', attempt = attempt + 1,
        updated_at = ${nowText} WHERE request_id = ${candidate.request_id} AND state IN ('ready', 'leased') RETURNING *`
        if (rows.length === 0) continue
        const row = rows[0]!
        yield* sql`UPDATE kernel_resume_attempts SET state = 'released',
          sent_at = COALESCE(sent_at, ${nowText}), updated_at = ${nowText}
          WHERE request_id = ${candidate.request_id} AND attempt = ${candidate.attempt}
            AND state = 'leased' AND lease_until <= ${nowText}`
        yield* sql`INSERT INTO kernel_resume_attempts (request_id, attempt, owning_host_id, worker_id,
        claim_token, lease_until, state, created_at, updated_at) VALUES (${row.request_id}, ${row.attempt},
        ${input.owningHostId}, ${input.workerId}, ${token}, ${until.toISOString()}, 'leased', ${nowText}, ${nowText})`
        yield* sql`UPDATE kernel_sessions SET state = 'active', revision = revision + 1,
          updated_at = ${nowText} WHERE session_id = ${row.session_id} AND state = 'ready'`
        return {
          requestId: String(row.request_id),
          sessionId: String(row.session_id),
          owningHostId: input.owningHostId,
          workerId: input.workerId,
          attempt: Number(row.attempt),
          maxAttempts: Number(row.max_attempts),
          claimToken: token,
          leaseUntil: until,
          prompt: decoded.success,
          promptText: String(row.prompt_text),
          outputContract: typeof row.output_contract === "string" ? row.output_contract : null,
          outputContractVersion:
            row.output_contract_version === null ? null : Number(row.output_contract_version),
        }
      }
      return null
    }).pipe(sql.withTransaction)

  const resumeWhere = (
    input: ResumeAuthority,
  ) => sql`request_id = ${input.requestId} AND attempt = ${input.attempt}
    AND owning_host_id = ${input.owningHostId} AND worker_id = ${input.workerId}
    AND claim_token = ${input.claimToken} AND lease_until = ${input.expectedLeaseUntil.toISOString()}
    AND lease_until > ${input.now.toISOString()}`
  const heartbeatResume: KernelSessionStorePort["heartbeatResume"] = (input) =>
    Effect.gen(function* () {
      yield* validateResumeAuthority(input)
      const ms = yield* positive(input.leaseDurationMs)
      const leaseUntil = yield* leaseDeadline(input.now, ms)
      const rows =
        yield* sql`UPDATE kernel_resume_attempts SET lease_until = ${leaseUntil.toISOString()},
      updated_at = ${input.now.toISOString()} WHERE ${resumeWhere(input)} AND state = 'leased' RETURNING request_id`
      if (rows.length === 0) return yield* denied(input.requestId)
      return { leaseUntil }
    }).pipe(sql.withTransaction)
  const markResumeSent: KernelSessionStorePort["markResumeSent"] = (input) =>
    Effect.gen(function* () {
      yield* validateResumeAuthority(input)
      const rows =
        yield* sql`UPDATE kernel_resume_attempts SET state = 'sent', sent_at = ${input.now.toISOString()},
      updated_at = ${input.now.toISOString()} WHERE ${resumeWhere(input)} AND state = 'leased' RETURNING request_id`
      if (rows.length === 0) return yield* denied(input.requestId)
      yield* sql`UPDATE kernel_resume_requests SET state = 'sent', updated_at = ${input.now.toISOString()}
      WHERE request_id = ${input.requestId} AND state = 'leased'`
    }).pipe(sql.withTransaction)
  const recoverExpiredResume: KernelSessionStorePort["recoverExpiredResume"] = (input) =>
    Effect.gen(function* () {
      yield* validDate(input.now)
      const rows = yield* sql`UPDATE kernel_resume_attempts SET state = 'observation_required',
      updated_at = ${input.now.toISOString()} WHERE owning_host_id = ${input.owningHostId} AND state = 'sent'
      AND lease_until <= ${input.now.toISOString()} RETURNING request_id`
      for (const row of rows)
        yield* sql`UPDATE kernel_resume_requests SET state = 'observation_required',
      updated_at = ${input.now.toISOString()} WHERE request_id = ${row.request_id} AND state = 'sent'`
      return rows.length
    }).pipe(sql.withTransaction)

  const checkpointResume: KernelSessionStorePort["checkpointResume"] = (input) =>
    Effect.gen(function* () {
      yield* validateResumeAuthority(input)
      yield* checkText(input.checkpointId)
      const version = yield* positive(input.checkpointVersion)
      const payload = yield* boundedJson(input.checkpoint)
      const accepted =
        yield* sql`SELECT request_id FROM kernel_resume_attempts WHERE ${resumeWhere(input)}
      AND state IN ('leased', 'sent')`
      if (accepted.length === 0) return yield* denied(input.requestId)
      const existing =
        yield* sql`SELECT * FROM kernel_resume_checkpoints WHERE checkpoint_id = ${input.checkpointId}`
      if (existing.length > 0) {
        const row = existing[0]!
        if (
          row.request_id === input.requestId &&
          row.attempt === input.attempt &&
          row.checkpoint_version === version &&
          row.checkpoint_json === payload.json
        )
          return { status: "duplicate" as const }
        return yield* conflict("checkpoint", input.checkpointId)
      }
      yield* sql`INSERT INTO kernel_resume_checkpoints (checkpoint_id, request_id, attempt,
      checkpoint_version, checkpoint_json, created_at) VALUES (${input.checkpointId}, ${input.requestId},
      ${input.attempt}, ${version}, ${payload.json}, ${input.now.toISOString()})`
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  const transitionResume = (
    input: ResumeAuthority,
    requestState: "failed" | "cancelled" | "ready",
    attemptState: "failed" | "cancelled" | "released",
    runAt?: Date,
  ) =>
    Effect.gen(function* () {
      yield* validateResumeAuthority(input)
      if (runAt !== undefined) yield* validDate(runAt)
      const changed = yield* sql`UPDATE kernel_resume_attempts SET state = ${attemptState},
      sent_at = COALESCE(sent_at, ${input.now.toISOString()}), updated_at = ${input.now.toISOString()}
      WHERE ${resumeWhere(input)} AND state IN ('leased', 'sent') RETURNING request_id`
      if (changed.length === 0) return yield* denied(input.requestId)
      yield* sql`UPDATE kernel_resume_requests SET state = ${requestState},
      run_at = ${runAt?.toISOString() ?? input.now.toISOString()}, updated_at = ${input.now.toISOString()}
      WHERE request_id = ${input.requestId} AND state IN ('leased', 'sent')`
      const sessionState = requestState === "ready" ? "ready" : "completed"
      yield* sql`UPDATE kernel_sessions SET state = ${sessionState}, revision = revision + 1,
        updated_at = ${input.now.toISOString()} WHERE session_id = (
          SELECT session_id FROM kernel_resume_requests WHERE request_id = ${input.requestId})`
    }).pipe(sql.withTransaction)
  const failResume: KernelSessionStorePort["failResume"] = (input) =>
    transitionResume(input, "failed", "failed")
  const cancelResume: KernelSessionStorePort["cancelResume"] = (input) =>
    transitionResume(input, "cancelled", "cancelled")
  const releaseResume: KernelSessionStorePort["releaseResume"] = (input) =>
    Effect.gen(function* () {
      yield* validateResumeAuthority(input)
      yield* validDate(input.runAt)
      const request = yield* sql<{
        readonly attempt: number
        readonly max_attempts: number
        readonly state: string
      }>`SELECT attempt, max_attempts, state FROM kernel_resume_requests
        WHERE request_id = ${input.requestId}`
      if (request[0]?.state === "sent") {
        const changed = yield* sql`UPDATE kernel_resume_attempts SET state = 'observation_required',
          updated_at = ${input.now.toISOString()} WHERE ${resumeWhere(input)} AND state = 'sent'
          RETURNING request_id`
        if (changed.length === 0) return yield* denied(input.requestId)
        yield* sql`UPDATE kernel_resume_requests SET state = 'observation_required',
          updated_at = ${input.now.toISOString()} WHERE request_id = ${input.requestId} AND state = 'sent'`
        return
      }
      return request[0]?.attempt === request[0]?.max_attempts
        ? yield* transitionResume(input, "failed", "released")
        : yield* transitionResume(input, "ready", "released", input.runAt)
    }).pipe(sql.withTransaction)

  const completeResume: KernelSessionStorePort["completeResume"] = (input) =>
    Effect.gen(function* () {
      yield* validateResumeAuthority(input)
      yield* checkText(input.resultId)
      const version = yield* positive(input.resultVersion)
      const payload = yield* boundedJson(input.result)
      const existing =
        yield* sql`SELECT * FROM kernel_resume_results WHERE request_id = ${input.requestId}`
      if (existing.length > 0) {
        const row = existing[0]!
        const accepted = yield* sql`SELECT request_id FROM kernel_resume_attempts
          WHERE request_id = ${input.requestId} AND attempt = ${input.attempt}
            AND owning_host_id = ${input.owningHostId} AND worker_id = ${input.workerId}
            AND claim_token = ${input.claimToken}
            AND lease_until = ${input.expectedLeaseUntil.toISOString()}`
        if (accepted.length === 0) return yield* denied(input.requestId)
        if (
          row.result_id === input.resultId &&
          row.attempt === input.attempt &&
          row.result_version === version &&
          row.result_json === payload.json
        )
          return { status: "duplicate" as const }
        return yield* conflict("result", input.resultId)
      }
      const changed = yield* sql`UPDATE kernel_resume_attempts SET state = 'completed',
      sent_at = COALESCE(sent_at, ${input.now.toISOString()}), updated_at = ${input.now.toISOString()}
      WHERE ${resumeWhere(input)} AND state IN ('leased', 'sent') RETURNING request_id`
      if (changed.length === 0) return yield* denied(input.requestId)
      yield* sql`INSERT INTO kernel_resume_results (result_id, request_id, attempt, result_version,
      result_json, completed_at) VALUES (${input.resultId}, ${input.requestId}, ${input.attempt},
      ${version}, ${payload.json}, ${input.now.toISOString()})`
      yield* sql`UPDATE kernel_resume_requests SET state = 'completed', updated_at = ${input.now.toISOString()}
      WHERE request_id = ${input.requestId}`
      yield* sql`UPDATE kernel_sessions SET state = 'completed', revision = revision + 1,
        updated_at = ${input.now.toISOString()} WHERE session_id = (
          SELECT session_id FROM kernel_resume_requests WHERE request_id = ${input.requestId})`
      return { status: "completed" as const }
    }).pipe(sql.withTransaction)

  const observeResume: KernelSessionStorePort["observeResume"] = (input) =>
    Effect.gen(function* () {
      yield* validDate(input.observedAt)
      yield* checkText(input.observationId)
      yield* checkText(input.observerHostId)
      yield* checkText(input.observerWorkerId)
      yield* checkText(input.observerToken)
      const version = yield* positive(input.evidenceVersion)
      const evidence = yield* boundedJson(input.evidence)
      const existing = yield* sql`SELECT * FROM kernel_resume_observations
        WHERE request_id = ${input.requestId} AND attempt = ${input.attempt}`
      if (existing.length > 0) {
        const row = existing[0]!
        if (
          row.request_id === input.requestId &&
          row.attempt === input.attempt &&
          row.observation_id === input.observationId &&
          row.observer_host_id === input.observerHostId &&
          row.observer_worker_id === input.observerWorkerId &&
          row.observer_token === input.observerToken &&
          row.disposition === input.disposition &&
          row.evidence_version === version &&
          row.evidence_json === evidence.json &&
          row.observed_at === input.observedAt.toISOString()
        )
          return { status: "duplicate" as const }
        return yield* conflict("observation", input.observationId)
      }
      const attempt =
        yield* sql`SELECT request_id FROM kernel_resume_attempts WHERE request_id = ${input.requestId}
      AND attempt = ${input.attempt} AND state = 'observation_required'`
      if (attempt.length === 0) return yield* denied(input.requestId)
      yield* sql`INSERT INTO kernel_resume_observations (observation_id, request_id, attempt,
      observer_host_id, observer_worker_id, observer_token, disposition, evidence_version,
      evidence_json, observed_at) VALUES (${input.observationId}, ${input.requestId}, ${input.attempt},
      ${input.observerHostId}, ${input.observerWorkerId}, ${input.observerToken}, ${input.disposition},
      ${version}, ${evidence.json}, ${input.observedAt.toISOString()})`
      const state = observationState(input.disposition)
      yield* sql`UPDATE kernel_resume_attempts SET state = ${state},
        updated_at = ${input.observedAt.toISOString()} WHERE request_id = ${input.requestId}
        AND attempt = ${input.attempt} AND state = 'observation_required'`
      yield* sql`UPDATE kernel_resume_requests SET state = ${state}, updated_at = ${input.observedAt.toISOString()}
      WHERE request_id = ${input.requestId} AND state = 'observation_required'`
      const sessionState = input.disposition === "missing" ? "missing" : state
      yield* sql`UPDATE kernel_sessions SET state = ${sessionState}, revision = revision + 1,
        updated_at = ${input.observedAt.toISOString()} WHERE session_id = (
          SELECT session_id FROM kernel_resume_requests WHERE request_id = ${input.requestId})`
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  const requestCleanup: KernelSessionStorePort["requestCleanup"] = (input) =>
    Effect.gen(function* () {
      for (const text of [input.cleanupId, input.resourceId, input.owningHostId])
        yield* checkText(text)
      yield* checkText(input.reason, 4096)
      yield* positive(input.maxAttempts)
      yield* validDate(input.runAt)
      yield* validDate(input.createdAt)
      const existing =
        yield* sql`SELECT * FROM kernel_cleanup_requests WHERE cleanup_id = ${input.cleanupId}`
      if (existing.length > 0) {
        const row = existing[0]!
        if (
          row.resource_id === input.resourceId &&
          row.owning_host_id === input.owningHostId &&
          row.reason === input.reason &&
          row.max_attempts === input.maxAttempts &&
          row.run_at === input.runAt.toISOString() &&
          row.created_at === input.createdAt.toISOString()
        ) {
          return { status: "duplicate" as const }
        }
        return yield* conflict("cleanup_request", input.cleanupId)
      }
      const active = yield* sql`SELECT request.request_id FROM kernel_resume_requests AS request
      JOIN kernel_sessions AS session ON session.session_id = request.session_id
      WHERE session.resource_id = ${input.resourceId} AND request.state IN (
        'ready', 'leased', 'sent', 'observation_required'
      )`
      if (active.length > 0) return yield* conflict("resume", input.resourceId)
      const resource = yield* sql`UPDATE kernel_working_resources SET state = 'cleanup_required',
      cleanup_reason = ${input.reason}, cleanup_error = NULL, updated_at = ${input.createdAt.toISOString()}
      WHERE resource_id = ${input.resourceId} AND owning_host_id = ${input.owningHostId} AND state = 'reserved'
      RETURNING resource_id`
      if (resource.length === 0) return yield* conflict("resource", input.resourceId)
      yield* sql`UPDATE kernel_sessions SET state = 'cleanup_required', revision = revision + 1,
        updated_at = ${input.createdAt.toISOString()} WHERE resource_id = ${input.resourceId}
          AND state IN ('ready', 'active', 'completed', 'missing')`
      yield* sql`INSERT INTO kernel_cleanup_requests (cleanup_id, resource_id, owning_host_id, reason,
      state, attempt, max_attempts, run_at, created_at, updated_at) VALUES (${input.cleanupId},
      ${input.resourceId}, ${input.owningHostId}, ${input.reason}, 'pending', 0, ${input.maxAttempts},
      ${input.runAt.toISOString()}, ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()})`
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  const claimCleanup: KernelSessionStorePort["claimCleanup"] = (input) =>
    Effect.gen(function* () {
      yield* checkText(input.owningHostId)
      yield* checkText(input.workerId)
      const ms = yield* positive(input.leaseDurationMs)
      yield* validDate(input.now)
      const until = yield* leaseDeadline(input.now, ms)
      const nowText = input.now.toISOString()
      const exhausted = yield* sql`UPDATE kernel_cleanup_requests SET state = 'operator_required',
        updated_at = ${nowText} WHERE owning_host_id = ${input.owningHostId} AND state = 'leased'
          AND attempt >= max_attempts AND EXISTS (SELECT 1 FROM kernel_cleanup_attempts AS attempt_row
            WHERE attempt_row.cleanup_id = kernel_cleanup_requests.cleanup_id
              AND attempt_row.attempt = kernel_cleanup_requests.attempt
              AND attempt_row.state = 'leased' AND attempt_row.lease_until <= ${nowText})
        RETURNING resource_id`
      for (const row of exhausted)
        yield* sql`UPDATE kernel_working_resources
        SET state = 'operator_required', cleanup_error = 'cleanup lease expired after final attempt',
          updated_at = ${nowText} WHERE resource_id = ${row.resource_id}`
      yield* sql`UPDATE kernel_cleanup_attempts SET state = 'operator_required', updated_at = ${nowText}
        WHERE owning_host_id = ${input.owningHostId} AND state = 'leased' AND lease_until <= ${nowText}
          AND EXISTS (SELECT 1 FROM kernel_cleanup_requests AS request
            WHERE request.cleanup_id = kernel_cleanup_attempts.cleanup_id
              AND request.attempt = kernel_cleanup_attempts.attempt AND request.state = 'operator_required')`
      const token = randomUUID()
      const malformed = yield* sql<Record<string, unknown>>`SELECT * FROM kernel_cleanup_requests
        WHERE owning_host_id = ${input.owningHostId} AND state IN ('pending', 'retry_scheduled')
          AND run_at <= ${nowText} ORDER BY run_at, cleanup_id`
      for (const candidate of malformed) {
        const decoded = yield* Schema.decodeUnknownEffect(CleanupReadRow)(candidate).pipe(
          Effect.result,
        )
        if (decoded._tag === "Failure") {
          yield* sql`UPDATE kernel_cleanup_requests SET state = 'data_error', updated_at = ${nowText}
            WHERE cleanup_id = ${candidate.cleanup_id}`
          yield* sql`UPDATE kernel_working_resources SET state = 'data_error',
            cleanup_error = 'malformed cleanup request', updated_at = ${nowText}
            WHERE resource_id = ${candidate.resource_id}`
        }
      }
      const rows =
        yield* sql`UPDATE kernel_cleanup_requests SET state = 'leased', attempt = attempt + 1,
      updated_at = ${nowText} WHERE cleanup_id = (SELECT cleanup_id FROM kernel_cleanup_requests
      WHERE owning_host_id = ${input.owningHostId} AND (
        (state IN ('pending', 'retry_scheduled') AND run_at <= ${nowText}) OR
        (state = 'leased' AND EXISTS (SELECT 1 FROM kernel_cleanup_attempts AS attempt_row
          WHERE attempt_row.cleanup_id = kernel_cleanup_requests.cleanup_id
            AND attempt_row.attempt = kernel_cleanup_requests.attempt
            AND attempt_row.state = 'leased' AND attempt_row.lease_until <= ${nowText}))
      ) AND attempt < max_attempts ORDER BY run_at, cleanup_id LIMIT 1)
      AND state IN ('pending', 'retry_scheduled', 'leased') RETURNING *`
      if (rows.length === 0) return null
      const row = rows[0]!
      yield* sql`INSERT INTO kernel_cleanup_attempts (cleanup_id, attempt, owning_host_id, worker_id,
      claim_token, lease_until, state, created_at, updated_at) VALUES (${row.cleanup_id}, ${row.attempt},
      ${input.owningHostId}, ${input.workerId}, ${token}, ${until.toISOString()}, 'leased', ${nowText}, ${nowText})`
      yield* sql`UPDATE kernel_working_resources SET state = 'cleanup_leased', updated_at = ${nowText}
      WHERE resource_id = ${row.resource_id} AND state = 'cleanup_required'`
      return {
        cleanupId: String(row.cleanup_id),
        resourceId: String(row.resource_id),
        reason: String(row.reason),
        owningHostId: input.owningHostId,
        workerId: input.workerId,
        attempt: Number(row.attempt),
        maxAttempts: Number(row.max_attempts),
        claimToken: token,
        leaseUntil: until,
      }
    }).pipe(sql.withTransaction)
  const cleanupWhere = (input: CleanupAuthority) => sql`cleanup_id = ${input.cleanupId}
    AND attempt = ${input.attempt} AND owning_host_id = ${input.owningHostId}
    AND worker_id = ${input.workerId} AND claim_token = ${input.claimToken}
    AND lease_until = ${input.expectedLeaseUntil.toISOString()} AND lease_until > ${input.now.toISOString()}`
  const heartbeatCleanup: KernelSessionStorePort["heartbeatCleanup"] = (input) =>
    Effect.gen(function* () {
      yield* validateCleanupAuthority(input)
      const ms = yield* positive(input.leaseDurationMs)
      const leaseUntil = yield* leaseDeadline(input.now, ms)
      const rows =
        yield* sql`UPDATE kernel_cleanup_attempts SET lease_until = ${leaseUntil.toISOString()},
      updated_at = ${input.now.toISOString()} WHERE ${cleanupWhere(input)} AND state = 'leased' RETURNING cleanup_id`
      if (rows.length === 0) return yield* denied(input.cleanupId)
      return { leaseUntil }
    }).pipe(sql.withTransaction)
  const completeCleanup: KernelSessionStorePort["completeCleanup"] = (input) =>
    Effect.gen(function* () {
      yield* validateCleanupAuthority(input)
      if (input.runAt !== undefined) yield* validDate(input.runAt)
      yield* checkText(input.outcomeId)
      const version = yield* positive(input.outcomeVersion)
      const payload = yield* boundedJson(input.outcome)
      const budget = yield* sql<{ readonly max_attempts: number }>`SELECT max_attempts
        FROM kernel_cleanup_requests WHERE cleanup_id = ${input.cleanupId}`
      const disposition = effectiveCleanupDisposition(
        input.disposition,
        input.attempt,
        budget[0]?.max_attempts ?? 0,
      )
      const existing = yield* sql`SELECT * FROM kernel_cleanup_outcomes
        WHERE cleanup_id = ${input.cleanupId} AND attempt = ${input.attempt}`
      if (existing.length > 0) {
        const row = existing[0]!
        if (
          row.attempt !== input.attempt ||
          row.owning_host_id !== input.owningHostId ||
          row.worker_id !== input.workerId ||
          row.claim_token !== input.claimToken ||
          row.lease_until !== input.expectedLeaseUntil.toISOString()
        )
          return yield* denied(input.cleanupId)
        if (
          row.outcome_id === input.outcomeId &&
          row.disposition === disposition &&
          row.outcome_version === version &&
          row.outcome_json === payload.json
        )
          return { status: "duplicate" as const }
        return yield* conflict("cleanup_outcome", input.outcomeId)
      }
      const reused = yield* sql`SELECT outcome_id FROM kernel_cleanup_outcomes
        WHERE outcome_id = ${input.outcomeId}`
      if (reused.length > 0) return yield* conflict("cleanup_outcome", input.outcomeId)
      const changed = yield* sql`UPDATE kernel_cleanup_attempts SET state = ${disposition},
      updated_at = ${input.now.toISOString()} WHERE ${cleanupWhere(input)} AND state = 'leased' RETURNING cleanup_id`
      if (changed.length === 0) return yield* denied(input.cleanupId)
      yield* sql`INSERT INTO kernel_cleanup_outcomes (outcome_id, cleanup_id, attempt, owning_host_id,
      worker_id, claim_token, lease_until, disposition, outcome_version, outcome_json, completed_at)
      VALUES (${input.outcomeId}, ${input.cleanupId}, ${input.attempt}, ${input.owningHostId},
      ${input.workerId}, ${input.claimToken}, ${input.expectedLeaseUntil.toISOString()}, ${disposition},
      ${version}, ${payload.json}, ${input.now.toISOString()})`
      const requestState = cleanupRequestState(disposition)
      yield* sql`UPDATE kernel_cleanup_requests SET state = ${requestState},
      run_at = ${input.runAt?.toISOString() ?? input.now.toISOString()}, updated_at = ${input.now.toISOString()}
      WHERE cleanup_id = ${input.cleanupId}`
      const resourceState = cleanupTerminalState(disposition)
      yield* sql`UPDATE kernel_working_resources SET state = ${resourceState},
      cleanup_error = ${cleanupError(disposition, payload.json)},
      updated_at = ${input.now.toISOString()} WHERE resource_id = (
        SELECT resource_id FROM kernel_cleanup_requests WHERE cleanup_id = ${input.cleanupId})`
      const sessionState = cleanupTerminalState(disposition)
      yield* sql`UPDATE kernel_sessions SET state = ${sessionState}, revision = revision + 1,
        updated_at = ${input.now.toISOString()} WHERE resource_id = (
          SELECT resource_id FROM kernel_cleanup_requests WHERE cleanup_id = ${input.cleanupId})
          AND state = 'cleanup_required'`
      return { status: "completed" as const }
    }).pipe(sql.withTransaction)

  const readOne = (
    table: string,
    key: string,
    value: string,
    schema: Schema.Codec<any, any>,
    record: string,
  ) =>
    sql
      .unsafe<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${key} = ?`, [value])
      .pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeRead(schema, record, value, rows[0]),
        ),
      )
  return KernelSessionStore.of({
    registerResource,
    registerSession,
    registerResumeRequest,
    claimResume,
    heartbeatResume,
    markResumeSent,
    recoverExpiredResume,
    checkpointResume,
    completeResume,
    failResume,
    cancelResume,
    releaseResume,
    observeResume,
    requestCleanup,
    claimCleanup,
    heartbeatCleanup,
    completeCleanup,
    readResource: (id) =>
      readOne("kernel_working_resources", "resource_id", id, ResourceReadRow, "resource"),
    readSession: (id) => readOne("kernel_sessions", "session_id", id, SessionReadRow, "session"),
    readResumeRequest: (id) =>
      readOne("kernel_resume_requests", "request_id", id, ResumeReadRow, "resume_request"),
    readLatestObservation: (id) =>
      sql`SELECT * FROM kernel_resume_observations WHERE request_id = ${id}
      ORDER BY observed_at DESC, observation_id DESC LIMIT 1`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(null)
            : decodeRead(ObservationReadRow, "observation", id, rows[0]),
        ),
      ),
    readResumeResult: (id) =>
      readOne(
        "kernel_resume_results",
        "request_id",
        id,
        Schema.Struct({
          result_id: Schema.String,
          request_id: Schema.String,
          attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
          result_version: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
          result_json: JsonText,
          completed_at: Timestamp,
        }),
        "resume_result",
      ),
    readRecoverableResume: (host) =>
      sql<Record<string, unknown>>`SELECT * FROM kernel_resume_requests
      WHERE owning_host_id = ${host} AND state IN ('ready', 'leased', 'sent', 'observation_required')
      ORDER BY run_at, request_id`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeRead(ResumeReadRow, "resume_request", String(row.request_id), row),
          ),
        ),
      ),
    readRecoverableCleanup: (host) =>
      sql<Record<string, unknown>>`SELECT * FROM kernel_cleanup_requests
      WHERE owning_host_id = ${host} AND state IN ('pending', 'leased', 'retry_scheduled', 'operator_required')
      ORDER BY run_at, cleanup_id`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeRead(CleanupReadRow, "cleanup_request", String(row.cleanup_id), row),
          ),
        ),
      ),
  })
})

export const KernelSessionStoreLive = Layer.effect(KernelSessionStore, make)
