import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import type { ParseResult } from "effect"
import { WorkSignal } from "../work-signal"
import { AgentHandoffStore, type AgentHandoffStoreError } from "./agent-handoff-store"
import type {
  KernelStoreConflictError,
  KernelStoreDataError,
  KernelStoreInputError,
} from "./event-store"
import {
  OpenCodeCompletionProvider,
  registerOpenCodeAgentWait,
  type OpenCodeCompletionSourceError,
  type OpenCodeCompletionSourceOptions,
} from "./opencode-completion-source"
import { canonicalJson } from "./session-store-support"

/**
 * The trusted output contract the woken parent must answer with. The resume
 * worker refuses to prompt a parent whose contract is not in its trusted
 * list, so this reference must stay in step with `resumeContracts` in
 * `src/layers.ts`.
 */
export const AGENT_WAKE_CONTRACT = { name: "workflowd.agent-wake", version: 1 } as const

export const AgentWakeResult = Schema.Struct({
  acknowledged: Schema.Literal(true),
  summary: Schema.String.pipe(Schema.maxLength(4_096)),
})

export const AGENT_WAKE_MAX_OUTPUT_BYTES = 16_384

/** Bounded well inside the store's 65 536-byte canonical prompt ceiling. */
export const MAX_RESUME_PROMPT_BYTES = 32_768
const MAX_SESSION_ID_BYTES = 256
const MAX_IDEMPOTENCY_KEY_BYTES = 128
const RESUME_MAX_ATTEMPTS = 3

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const bounded = (maximum: number) =>
  Schema.NonEmptyString.pipe(
    Schema.filter((value) => utf8Bytes(value) <= maximum, {
      message: () => `must be at most ${maximum} UTF-8 bytes`,
    }),
  )

export const AgentWaitSubmission = Schema.Struct({
  parentSessionId: bounded(MAX_SESSION_ID_BYTES),
  childSessionId: bounded(MAX_SESSION_ID_BYTES),
  resumePrompt: bounded(MAX_RESUME_PROMPT_BYTES),
  idempotencyKey: Schema.optional(bounded(MAX_IDEMPOTENCY_KEY_BYTES)),
})
export type AgentWaitSubmission = typeof AgentWaitSubmission.Type

export type AgentWaitReceipt = {
  readonly waitId: string
  readonly instanceId: string
  readonly status: "registered" | "duplicate"
}

export type AgentWaitCustodyReason =
  | "not_in_kernel_custody"
  | "session_not_ready"
  | "unsupported_provider"
  | "working_resource_not_reserved"

/**
 * Raised when a supplied session is not in kernel custody, or is in custody
 * but not in a state that can be watched or woken. Registration fails closed:
 * no watch row is written and no parallel custody record is invented.
 */
export class AgentWaitCustodyError extends Data.TaggedError("AgentWaitCustodyError")<{
  readonly role: "parent" | "child"
  readonly sessionId: string
  readonly reason: AgentWaitCustodyReason
  readonly observed: string | null
}> {
  get explanation(): string {
    const subject = `${this.role} session ${this.sessionId}`
    switch (this.reason) {
      case "not_in_kernel_custody":
        return (
          `${subject} is not in kernel custody: no row in kernel_sessions joined to ` +
          "kernel_working_resources. Sessions must be registered through " +
          "KernelSessionStore.registerSession before they can be watched or woken."
        )
      case "session_not_ready":
        return `${subject} is in kernel custody but its state is '${this.observed}', not ready or active`
      case "unsupported_provider":
        return (
          `${subject} is held by provider '${this.observed}'; agent waits currently ` +
          "support the opencode provider only"
        )
      case "working_resource_not_reserved":
        return (
          `${subject} has a working resource in state '${this.observed}', not reserved, ` +
          "so its working directory is not held for this session"
        )
    }
  }
}

export type AgentWaitIngressError =
  | AgentWaitCustodyError
  | AgentHandoffStoreError
  | OpenCodeCompletionSourceError
  | KernelStoreConflictError
  | KernelStoreDataError
  | KernelStoreInputError
  | SqlError
  | ParseResult.ParseError

export type AgentWaitIngressPort = {
  readonly register: (
    input: AgentWaitSubmission,
    now: Date,
  ) => Effect.Effect<AgentWaitReceipt, AgentWaitIngressError>
}

export const AgentWaitIngress = Context.GenericTag<AgentWaitIngressPort>(
  "workflowd/kernel/AgentWaitIngress",
)

const CustodyRow = Schema.Struct({
  session_id: Schema.String,
  state: Schema.String,
  revision: Schema.Int.pipe(Schema.positive()),
  provider_kind: Schema.String,
  resource_state: Schema.String,
})

/**
 * The exact prompt document the parent receives. The store requires
 * `resumePromptText === canonicalJson(resumePrompt)`, and the resume worker
 * sends that text verbatim, so the caller's plain-string prompt is wrapped in
 * a single-field object rather than JSON-quoted on its own. A parent woken by
 * this path is prompted with `{"task":"<resume_prompt>"}`.
 */
export const agentWakePrompt = (resumePrompt: string) => {
  const value = { task: resumePrompt }
  return { resumePrompt: value, resumePromptText: canonicalJson(value) }
}

/**
 * Identity of the durable wait. Two calls that describe the same handoff
 * collapse onto the same workflow instance, so replay is a duplicate receipt
 * rather than a second watch. An explicit idempotency key pins that identity
 * when the caller wants to retry without depending on the derived one; the
 * instance payload is still immutable, so reusing a key with a different
 * prompt is a conflict rather than a silent overwrite.
 */
export const agentWaitIdentifiers = (input: {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly childSessionGeneration: number
  readonly resumePromptText: string
  readonly idempotencyKey?: string | undefined
}) => {
  const identity =
    input.idempotencyKey ??
    [
      input.parentSessionId,
      input.childSessionId,
      String(input.childSessionGeneration),
      input.resumePromptText,
    ].join("\0")
  const digest = createHash("sha256").update(identity, "utf8").digest("hex")
  return { instanceId: `agent-wait-instance-${digest}`, waitId: `agent-wait-${digest}` }
}

const readCustody = (role: "parent" | "child", sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT session.session_id, session.state, session.revision,
        session.provider_kind, resource.state AS resource_state
      FROM kernel_sessions AS session
      JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
      WHERE session.session_id = ${sessionId}`
    if (rows.length === 0) {
      return yield* new AgentWaitCustodyError({
        role,
        sessionId,
        reason: "not_in_kernel_custody",
        observed: null,
      })
    }
    const custody = yield* Schema.decodeUnknown(CustodyRow)(rows[0])
    if (custody.provider_kind !== "opencode") {
      return yield* new AgentWaitCustodyError({
        role,
        sessionId,
        reason: "unsupported_provider",
        observed: custody.provider_kind,
      })
    }
    if (custody.state !== "ready" && custody.state !== "active") {
      return yield* new AgentWaitCustodyError({
        role,
        sessionId,
        reason: "session_not_ready",
        observed: custody.state,
      })
    }
    if (custody.resource_state !== "reserved") {
      return yield* new AgentWaitCustodyError({
        role,
        sessionId,
        reason: "working_resource_not_reserved",
        observed: custody.resource_state,
      })
    }
    return custody
  })

const make = (options: OpenCodeCompletionSourceOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const handoffs = yield* AgentHandoffStore
    const provider = yield* OpenCodeCompletionProvider
    const signals = yield* WorkSignal

    const register: AgentWaitIngressPort["register"] = (input, now) =>
      Effect.gen(function* () {
        const submission = yield* Schema.decodeUnknown(AgentWaitSubmission)(input, {
          onExcessProperty: "error",
        })
        // Custody is validated before anything durable is written so a caller
        // naming a session the kernel does not hold gets a precise refusal
        // rather than a half-built watch.
        const child = yield* readCustody("child", submission.childSessionId)
        yield* readCustody("parent", submission.parentSessionId)
        const prompt = agentWakePrompt(submission.resumePrompt)
        const identifiers = agentWaitIdentifiers({
          parentSessionId: submission.parentSessionId,
          childSessionId: submission.childSessionId,
          childSessionGeneration: child.revision,
          resumePromptText: prompt.resumePromptText,
          idempotencyKey: submission.idempotencyKey,
        })
        const registered = yield* registerOpenCodeAgentWait(
          {
            instanceId: identifiers.instanceId,
            waitId: identifiers.waitId,
            workflow: {
              kind: "wait_for_agent",
              childSessionId: submission.childSessionId,
              childSessionGeneration: child.revision,
              parentSessionId: submission.parentSessionId,
              resumePrompt: prompt.resumePrompt,
              resumePromptText: prompt.resumePromptText,
              outputContract: AGENT_WAKE_CONTRACT.name,
              outputContractVersion: AGENT_WAKE_CONTRACT.version,
              retryPolicy: { maxAttempts: RESUME_MAX_ATTEMPTS },
            },
            registeredAt: now,
          },
          options,
        )
        return { ...identifiers, status: registered.status }
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(AgentHandoffStore, handoffs),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      )

    return AgentWaitIngress.of({ register })
  })

export const AgentWaitIngressLive = (options: OpenCodeCompletionSourceOptions) =>
  Layer.effect(AgentWaitIngress, make(options))
