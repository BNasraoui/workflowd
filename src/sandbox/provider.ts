import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentHandoffStore,
  AgentHandoffStoreError,
  type AgentHandoffStorePort,
} from "../kernel/agent-handoff-store"
import { OpenCodeAdapterError } from "../opencode/adapter"
import type { AgentRunProviderPort } from "../kernel/agent-run-ingress"
import type { SandboxDispatchPort } from "./dispatch"
import { makeSandboxStore } from "./store"

export const routeSandboxProvider = (shared: AgentRunProviderPort, sandbox: SandboxDispatchPort) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const resolve = (sessionId: string) =>
      Effect.gen(function* () {
        const lease = yield* store.bySession(sessionId)
        return lease === null ? shared : yield* sandbox.provider(sessionId)
      }).pipe(
        Effect.mapError(
          () =>
            new OpenCodeAdapterError({
              operation: "route saved sandbox session",
              cause: new Error("Sandbox session binding unavailable"),
            }),
        ),
      )
    return {
      createSession: shared.createSession,
      listProviders: shared.listProviders,
      listModels: shared.listModels,
      promptSession: (input) =>
        resolve(input.sessionID).pipe(Effect.flatMap((provider) => provider.promptSession(input))),
      abortSession: (input) =>
        resolve(input.sessionID).pipe(Effect.flatMap((provider) => provider.abortSession(input))),
      sessionTelemetry: (input) =>
        resolve(input.sessionID).pipe(
          Effect.flatMap((provider) => provider.sessionTelemetry(input)),
        ),
    } satisfies AgentRunProviderPort
  })

export const routeSandboxHandoffs = Effect.gen(function* () {
  const handoffs = yield* AgentHandoffStore
  const sql = yield* SqlClient.SqlClient
  const register: AgentHandoffStorePort["register"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT session.* FROM kernel_sessions session
      JOIN sandbox_leases lease ON lease.session_id=session.native_session_id
      JOIN kernel_agent_runs run ON run.run_id=lease.run_id AND run.session_id=session.session_id
      WHERE session.session_id=${input.workflow.childSessionId}
        AND session.provider_kind='opencode' AND session.endpoint_alias='sandbox'
        AND session.server_id='sandbox:' || session.native_session_id
        AND session.owning_host_id=${input.completionSource.owningHostId}
        AND lease.unit IS NOT NULL AND lease.invocation IS NOT NULL`
      if (rows.length === 0) return yield* handoffs.register(input)
      const identity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          provider_id: Schema.String,
          server_id: Schema.String,
          endpoint_alias: Schema.String,
          endpoint_identity: Schema.String,
          provider_version: Schema.Int,
        }),
      )(rows[0]).pipe(
        Effect.mapError(
          (cause) =>
            new AgentHandoffStoreError({
              operation: "read saved sandbox completion identity",
              cause,
            }),
        ),
      )
      // Keep the existing handoff validation, transaction and parent authorization.
      // Only a child already bound to a managed lease selects a dedicated source.
      return yield* handoffs.register({
        ...input,
        completionSource: {
          ...input.completionSource,
          providerId: identity.provider_id,
          serverId: identity.server_id,
          endpointAlias: identity.endpoint_alias,
          endpointIdentity: identity.endpoint_identity,
          providerVersion: identity.provider_version,
        },
      })
    })
  return { register } satisfies AgentHandoffStorePort
})
