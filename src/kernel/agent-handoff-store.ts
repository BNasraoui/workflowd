import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { canonicalJson } from "./session-store-support"
import {
  AgentSessionCompletedEventV1,
  AGENT_SESSION_COMPLETED_TYPE,
  AGENT_SESSION_COMPLETED_VERSION,
  WaitForAgentWorkflowV1,
  WAIT_FOR_AGENT_WORKFLOW_TYPE,
  WAIT_FOR_AGENT_WORKFLOW_VERSION,
  agentSessionCompletionCondition,
} from "./agent-handoff-contract"
import {
  KernelEventStore,
  type KernelEventStorePort,
  type KernelStoreConflictError,
  type KernelStoreDataError,
  KernelStoreInputError,
  type RecordEventResult,
} from "./event-store"

const SessionCustodyRow = Schema.Struct({
  session_id: Schema.String,
  provider_kind: Schema.Literals(["opencode", "codex", "claude"]),
  provider_version: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  provider_id: Schema.String,
  server_id: Schema.String,
  owning_host_id: Schema.String,
  endpoint_alias: Schema.String,
  endpoint_identity: Schema.String,
  native_session_id: Schema.String,
  resource_id: Schema.String,
  resource_state: Schema.String,
  state: Schema.String,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})

export class AgentHandoffStoreError extends Data.TaggedError("AgentHandoffStoreError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

type EventStoreError =
  SqlError | KernelStoreConflictError | KernelStoreDataError | KernelStoreInputError
type StoreError = SqlError | EventStoreError | AgentHandoffStoreError

export type RegisterAgentWaitInput = {
  readonly instanceId: string
  readonly waitId: string
  readonly workflow: WaitForAgentWorkflowV1
  readonly completionSource: AgentCompletionSourceIdentity
  readonly registeredAt: Date
}

export type AgentCompletionSourceIdentity = {
  readonly owningHostId: string
  readonly providerId: string
  readonly serverId: string
  readonly endpointAlias: string
  readonly endpointIdentity: string
  readonly providerVersion: number
}

export type AgentHandoffStorePort = {
  readonly register: (
    input: RegisterAgentWaitInput,
  ) => Effect.Effect<{ readonly status: "registered" | "duplicate" }, StoreError>
}

export const AgentHandoffStore = Context.Service<AgentHandoffStorePort>(
  "workflowd/kernel/AgentHandoffStore",
)

const decodeError = (operation: string) => (cause: unknown) =>
  new AgentHandoffStoreError({ operation, cause })

const decodeWorkflow = (value: unknown) =>
  Schema.decodeUnknownEffect(WaitForAgentWorkflowV1)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(decodeError("decode wait-for-agent workflow")),
    Effect.flatMap((workflow) =>
      canonicalJson(workflow.resumePrompt) === workflow.resumePromptText
        ? Effect.succeed(workflow)
        : Effect.fail(
            new AgentHandoffStoreError({
              operation: "validate exact resume prompt",
              cause: new Error("resume prompt text is not canonical"),
            }),
          ),
    ),
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore

  const register: AgentHandoffStorePort["register"] = (input) =>
    Effect.gen(function* () {
      const workflow = yield* decodeWorkflow(input.workflow)
      yield* events.createInstance({
        instanceId: input.instanceId,
        workflowType: WAIT_FOR_AGENT_WORKFLOW_TYPE,
        workflowVersion: WAIT_FOR_AGENT_WORKFLOW_VERSION,
        workflowKey: `${workflow.parentSessionId}:${workflow.childSessionId}`,
        payload: workflow,
        createdAt: input.registeredAt,
      })
      const sessionRows = yield* sql`SELECT session.*, resource.state AS resource_state
        FROM kernel_sessions AS session
        JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
        WHERE session.session_id = ${workflow.childSessionId}`
      const child = yield* Schema.decodeUnknownEffect(SessionCustodyRow)(sessionRows[0]).pipe(
        Effect.mapError(decodeError("decode child session custody")),
      )
      if (
        child.session_id !== workflow.childSessionId ||
        child.revision !== workflow.childSessionGeneration ||
        !["ready", "active"].includes(child.state) ||
        child.resource_state !== "reserved" ||
        child.provider_kind !== "opencode" ||
        child.provider_version !== input.completionSource.providerVersion ||
        child.provider_id !== input.completionSource.providerId ||
        child.server_id !== input.completionSource.serverId ||
        child.owning_host_id !== input.completionSource.owningHostId ||
        child.endpoint_alias !== input.completionSource.endpointAlias ||
        child.endpoint_identity !== input.completionSource.endpointIdentity
      ) {
        return yield* new AgentHandoffStoreError({
          operation: "validate child session generation",
          cause: new Error("child session is stale or unavailable"),
        })
      }
      const parentRows = yield* sql`SELECT session.*, resource.state AS resource_state
        FROM kernel_sessions AS session
        JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
        WHERE session.session_id = ${workflow.parentSessionId}`
      const parent = yield* Schema.decodeUnknownEffect(SessionCustodyRow)(parentRows[0]).pipe(
        Effect.mapError(decodeError("decode parent session custody")),
      )
      if (
        parent.session_id !== workflow.parentSessionId ||
        !["ready", "active"].includes(parent.state) ||
        parent.resource_state !== "reserved" ||
        // Parents are woken by their own provider's resume worker: opencode
        // via the server API, claude via the claude CLI.
        !["opencode", "claude"].includes(parent.provider_kind)
      ) {
        return yield* new AgentHandoffStoreError({
          operation: "validate parent session",
          cause: new Error("parent session is unavailable"),
        })
      }
      const inserted = yield* sql`INSERT INTO kernel_agent_completion_watches (
        instance_id, wait_id, child_session_id, child_session_generation,
        provider_kind, provider_version, provider_id, server_id, owning_host_id,
        endpoint_alias, endpoint_identity, native_session_id, resource_id,
        state, completion_event_sequence, registered_at, updated_at
      ) VALUES (
        ${input.instanceId}, ${input.waitId}, ${child.session_id}, ${workflow.childSessionGeneration},
        ${child.provider_kind}, ${child.provider_version}, ${child.provider_id}, ${child.server_id},
        ${child.owning_host_id}, ${child.endpoint_alias}, ${child.endpoint_identity},
        ${child.native_session_id}, ${child.resource_id}, 'watching', NULL,
        ${input.registeredAt.toISOString()}, ${input.registeredAt.toISOString()}
      ) ON CONFLICT (instance_id) DO NOTHING RETURNING instance_id`
      if (inserted.length === 0) {
        const existing = yield* sql`SELECT wait_id, child_session_id, child_session_generation,
            provider_kind, provider_version, provider_id, server_id, owning_host_id,
            endpoint_alias, endpoint_identity, native_session_id, resource_id
          FROM kernel_agent_completion_watches WHERE instance_id = ${input.instanceId}`
        const row = existing[0]
        const exact =
          row?.wait_id === input.waitId &&
          row.child_session_id === workflow.childSessionId &&
          row.child_session_generation === workflow.childSessionGeneration &&
          row.provider_kind === child.provider_kind &&
          row.provider_version === child.provider_version &&
          row.provider_id === child.provider_id &&
          row.server_id === child.server_id &&
          row.owning_host_id === child.owning_host_id &&
          row.endpoint_alias === child.endpoint_alias &&
          row.endpoint_identity === child.endpoint_identity &&
          row.native_session_id === child.native_session_id &&
          row.resource_id === child.resource_id
        if (!exact) {
          return yield* new AgentHandoffStoreError({
            operation: "validate saved watch replay",
            cause: new Error("saved watch differs from replay"),
          })
        }
      }
      yield* events.registerWait({
        instanceId: input.instanceId,
        waitId: input.waitId,
        condition: agentSessionCompletionCondition(workflow),
        registeredAt: input.registeredAt,
      })
      return { status: inserted.length > 0 ? ("registered" as const) : ("duplicate" as const) }
    }).pipe(sql.withTransaction)

  return AgentHandoffStore.of({ register })
})

export const AgentHandoffStoreLive = Layer.effect(AgentHandoffStore, make)

export const recordAgentSessionCompletion = (input: {
  readonly source: string
  readonly sourceEventId: string
  readonly childSessionId: string
  readonly childSessionGeneration: number
  readonly completionId: string
  readonly completedAt: Date
}): Effect.Effect<RecordEventResult, EventStoreError, KernelEventStorePort> =>
  Effect.gen(function* () {
    const events = yield* KernelEventStore
    const payload = yield* Schema.decodeUnknownEffect(AgentSessionCompletedEventV1)(
      {
        childSessionId: input.childSessionId,
        childSessionGeneration: input.childSessionGeneration,
        completionId: input.completionId,
        completedAt: input.completedAt.toISOString(),
      },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new KernelStoreInputError({
            message: `invalid agent completion event: ${String(cause)}`,
          }),
      ),
    )
    return yield* events.recordEvent({
      source: input.source,
      sourceEventId: input.sourceEventId,
      event: {
        type: AGENT_SESSION_COMPLETED_TYPE,
        version: AGENT_SESSION_COMPLETED_VERSION,
        key: payload.childSessionId,
        correlation: `${payload.childSessionId}:${payload.childSessionGeneration}`,
        payload,
      },
      recordedAt: input.completedAt,
    })
  })
