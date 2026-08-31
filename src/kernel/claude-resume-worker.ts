import { randomUUID } from "node:crypto"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Schema } from "effect"
import { boundedAgentPayload } from "../agent-payload"
import { JsonValueSchema } from "../json"
import { structuredExtractionPrompt } from "../opencode/adapter"
import { ClaudeResumeRemoteProducer } from "../remote/claude-resume-producer"
import { ClaudeCli, claudeHostFromEndpointIdentity } from "./claude-session"
import { KernelJobStore, type KernelJobStoreError } from "./job-store"
import { canonicalJson } from "./session-store-support"
import { KernelSessionStore, type KernelSessionStoreError, type ResumeClaim } from "./session-store"

/**
 * Delivers wakes to Claude Code sessions, closing the loop for Claude
 * dispatchers the way the OpenCode resume worker does for opencode ones.
 * Delivery is two `claude -p --resume` turns: the canonical resume prompt,
 * then the schema-bearing extraction prompt whose reply must be the trusted
 * structured acknowledgment. The claude CLI (subscription auth) is the only
 * channel — never provider routing.
 *
 * Sessions on this daemon's host are woken by spawning the CLI directly. A
 * session owned by another allow-listed host is woken by that host's
 * workflowd runner: the worker enqueues a single-attempt claude_resume
 * remote kernel job (both turns execute runner-side), parks the resume in
 * observation_required with a durable checkpoint naming the job, and a
 * later iteration observes the job's terminal state to complete or
 * escalate. The daemon owns the whole lifecycle either way.
 *
 * A crash between the durable sent fence and completion with no such
 * checkpoint cannot be re-attributed from a CLI transcript, so restart
 * recovery escalates to operator_required rather than guessing.
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
  /** Hosts (besides the daemon host) whose Claude sessions this worker may
   * wake through their workflowd runner. */
  readonly claudeHosts: ReadonlyArray<string>
  /** Per-CLI-turn timeout carried in remote wake payloads. */
  readonly remoteTurnTimeoutMs: number
  readonly now: () => Date
  readonly contracts: ReadonlyArray<ClaudeResumeContract>
}

export class ClaudeResumeWorkerError extends Data.TaggedError("ClaudeResumeWorkerError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export type ClaudeResumeWorkerPort = {
  readonly iteration: Effect.Effect<
    "idle" | "completed" | "operator_required" | "retry_scheduled" | "remote_dispatched",
    | ClaudeResumeWorkerError
    | KernelSessionStoreError
    | KernelJobStoreError
    | SqlError
    | Schema.SchemaError
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
    const deliverable =
      deliveryHost !== null &&
      (deliveryHost === options.owningHostId || options.claudeHosts.includes(deliveryHost))
    if (
      session.provider_kind !== "claude" ||
      session.owning_host_id !== options.owningHostId ||
      deliveryHost === null ||
      !deliverable
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
    if (deliveryHost === options.owningHostId) {
      // Only a same-host transcript can be probed; remote transcripts are
      // checked by the owning host's runner at delivery.
      const exists = yield* cli
        .sessionExists({
          nativeSessionId: session.native_session_id,
          directory: resource.absolute_path,
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

const RemoteJobCheckpoint = Schema.Struct({ remoteJobId: Schema.String })

/** The result document the coordinator stores for a claude_resume job, as
 * published by the owning host's runner. */
const RemoteJobResultDocument = Schema.Struct({
  kind: Schema.Literal("claude_resume"),
  status: Schema.Literals(["succeeded", "failed"]),
  output: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
})

const RecoverableRow = Schema.Struct({
  request_id: Schema.String,
  session_id: Schema.String,
  attempt: Schema.Int,
  output_contract: Schema.NullOr(Schema.String),
  output_contract_version: Schema.NullOr(Schema.Int),
})

/** Records the observed outcome of a parked claude resume, mirroring the
 * opencode restart observer: completion also writes the durable result. */
const recordClaudeObservation = (
  request: typeof RecoverableRow.Type,
  options: ClaudeResumeWorkerOptions,
  disposition: "completed" | "operator_required",
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
        observationId: `${request.request_id}:${request.attempt}:claude-observation`,
        observerHostId: options.owningHostId,
        observerWorkerId: options.workerId,
        observerToken: randomUUID(),
        disposition,
        evidenceVersion: 1,
        evidence,
        observedAt,
      })
      if (disposition === "completed" && resultVersion !== undefined) {
        const completed = yield* Schema.decodeUnknownEffect(CompletedRemoteEvidence)(evidence)
        yield* sql`INSERT INTO kernel_resume_results (result_id, request_id, attempt, result_version,
          result_json, completed_at) VALUES (${`${request.request_id}:result`}, ${request.request_id},
          ${request.attempt}, ${resultVersion}, ${canonicalJson(completed.result)}, ${observedAt.toISOString()})`
      }
    }).pipe(sql.withTransaction)
    return { status: disposition, requestId: request.request_id }
  })

const CompletedRemoteEvidence = Schema.Struct({
  reason: Schema.Literal("remote_delivered"),
  result: JsonValueSchema,
})

/** Validates a remote runner's extracted output exactly the way the local
 * path validates a CLI answer. */
const validateRemoteOutput = (output: string, contract: ClaudeResumeContract) =>
  Effect.gen(function* () {
    const structured = yield* parseStructured(output)
    const bounded = yield* Schema.decodeUnknownEffect(
      boundedAgentPayload(contract.maxOutputBytes, "claude resume output"),
    )(structured)
    const validated = yield* Schema.decodeUnknownEffect(contract.schema)(bounded)
    return yield* Schema.decodeUnknownEffect(JsonValueSchema)(validated)
  })

/**
 * Observes parked claude resumes. A version-2 checkpoint names the remote
 * kernel job carrying the wake: its terminal state decides the resume. A
 * parked resume with no such checkpoint is a true crash after the sent
 * fence — unattributable from a CLI transcript that no longer exists —
 * and escalates, exactly as before remote delivery existed.
 */
const observeClaudeResume = (options: ClaudeResumeWorkerOptions) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    const jobs = yield* KernelJobStore
    const sql = yield* SqlClient.SqlClient
    const recoverable = yield* store.readRecoverableResume(options.owningHostId)
    for (const row of recoverable) {
      if (row.state !== "observation_required") continue
      const decoded = yield* Schema.decodeUnknownEffect(RecoverableRow)(row).pipe(Effect.result)
      if (decoded._tag === "Failure") continue
      const request = decoded.success
      const sessionUnknown = yield* store.readSession(request.session_id)
      const kind =
        sessionUnknown !== null && typeof sessionUnknown.provider_kind === "string"
          ? sessionUnknown.provider_kind
          : ""
      if (kind !== "claude") continue
      const checkpointRows = yield* sql<{ readonly checkpoint_json: string }>`
        SELECT checkpoint_json FROM kernel_resume_checkpoints
        WHERE request_id = ${request.request_id} AND attempt = ${request.attempt}
          AND checkpoint_version = 2
        ORDER BY created_at DESC LIMIT 1`
      if (checkpointRows.length === 0) {
        const at = options.now()
        yield* sql`UPDATE kernel_resume_attempts SET state = 'operator_required',
          updated_at = ${at.toISOString()} WHERE request_id = ${request.request_id}
          AND state = 'observation_required'`
        yield* sql`UPDATE kernel_resume_requests SET state = 'operator_required',
          updated_at = ${at.toISOString()} WHERE request_id = ${request.request_id}
          AND state = 'observation_required'`
        return {
          status: "operator_required" as const,
          requestId: request.request_id,
          reason: "restart_unattributable",
        }
      }
      const checkpoint = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(RemoteJobCheckpoint),
      )(checkpointRows[0]!.checkpoint_json).pipe(Effect.result)
      if (checkpoint._tag === "Failure") {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "corrupt_remote_checkpoint",
        })
      }
      const job = yield* jobs.readJob(checkpoint.success.remoteJobId)
      if (job === null) {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "remote_job_missing",
        })
      }
      if (job.state === "ready" || job.state === "leased" || job.state === "retry_scheduled") {
        continue // still in flight; observe again on a later tick
      }
      if (job.state !== "succeeded") {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "remote_job_failed",
          jobState: job.state,
        })
      }
      const jobResult = yield* jobs.readResult(checkpoint.success.remoteJobId)
      const document = yield* Schema.decodeUnknownEffect(RemoteJobResultDocument)(
        jobResult?.result ?? {},
      ).pipe(Effect.result)
      if (document._tag === "Failure") {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "remote_result_malformed",
        })
      }
      if (document.success.status === "failed" || document.success.output === undefined) {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "remote_delivery_failed",
          failureReason: document.success.failureReason ?? "unknown",
        })
      }
      const contract = options.contracts.find(
        (candidate) =>
          candidate.name === request.output_contract &&
          candidate.version === request.output_contract_version,
      )
      if (contract === undefined) {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "unsupported_output_contract",
        })
      }
      const validated = yield* validateRemoteOutput(document.success.output, contract).pipe(
        Effect.result,
      )
      if (validated._tag === "Failure") {
        return yield* recordClaudeObservation(request, options, "operator_required", {
          reason: "remote_output_invalid",
        })
      }
      yield* recordClaudeObservation(
        request,
        options,
        "completed",
        { reason: "remote_delivered", result: validated.success },
        contract.version,
      )
      return { status: "completed" as const, requestId: request.request_id }
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
      return (yield* observeClaudeResume(options)) ?? { status: "idle" as const }
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

    if (reference.host !== options.owningHostId) {
      // Remote delivery: the owning host's runner executes both CLI turns.
      // The sent fence stands, the job is single-attempt, and the resume
      // parks in observation_required until the job reaches a terminal
      // state — the daemon never re-wakes on its own.
      const producer = yield* ClaudeResumeRemoteProducer
      const enqueued = yield* producer
        .enqueue(
          {
            requestId: claim.requestId,
            attempt: claim.attempt,
            payload: {
              kind: "claude_resume",
              hostId: reference.host,
              nativeSessionId: reference.nativeSessionId,
              directory: reference.directory,
              prompt: claim.promptText,
              extractionSchemaJson: JSON.stringify(contract.jsonSchema),
              turnTimeoutMs: options.remoteTurnTimeoutMs,
            },
          },
          options.now(),
        )
        .pipe(Effect.result)
      if (enqueued._tag === "Failure") {
        const reason =
          enqueued.failure._tag === "ClaudeResumePromptTooLarge"
            ? "prompt_exceeds_remote_budget"
            : enqueued.failure._tag === "SchemaError"
              ? "remote_payload_invalid"
              : null
        if (reason !== null) return yield* operatorRequired(claim, options, reason)
        return yield* Effect.fail(
          new ClaudeResumeWorkerError({
            operation: "enqueue remote claude wake",
            cause: enqueued.failure,
          }),
        )
      }
      yield* store.checkpointResume({
        ...authorityOf(claim, options.now()),
        checkpointId: `${claim.requestId}:${claim.attempt}:remote-job`,
        checkpointVersion: 2,
        checkpoint: { remoteJobId: enqueued.success.jobId },
      })
      yield* store.releaseResume({ ...authorityOf(claim, options.now()), runAt: options.now() })
      return { status: "remote_dispatched" as const, requestId: claim.requestId }
    }

    const cliCall = (prompt: string) =>
      cli
        .resume({
          nativeSessionId: reference.nativeSessionId,
          directory: reference.directory,
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
