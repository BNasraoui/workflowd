import { OpenCode } from "@opencode-ai/client/effect"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentHandoffStore,
  AgentHandoffStoreError,
  type AgentHandoffStorePort,
} from "../kernel/agent-handoff-store"
import { FetchHttpClient } from "effect/unstable/http"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../opencode/adapter"
import { OpenCodeAdapterError } from "../opencode/adapter"
import type { AgentRunProviderPort } from "../kernel/agent-run-ingress"
import type { SandboxDispatchPort } from "./dispatch"
import { makeSandboxStore } from "./store"

export function createSandboxProvider(endpoint: {
  readonly url: string
  readonly password: string
}) {
  const origin = new URL(endpoint.url).origin
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Invalid sandbox endpoint")
  const boundedFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.origin !== origin) throw new Error("Sandbox endpoint changed")
      const headers = new Headers(init?.headers)
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`,
      )
      const response = await fetch(input, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.any([
          ...(init?.signal == null ? [] : [init.signal]),
          AbortSignal.timeout(20000),
        ]),
      })
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body?.getReader()
      if (reader !== undefined) {
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            const bytes: unknown = chunk.value
            if (!(bytes instanceof Uint8Array)) throw new Error("Invalid sandbox response bytes")
            size += bytes.byteLength
            if (size > 1048576) throw new Error("Sandbox API output exceeds 1 MiB")
            chunks.push(bytes)
          }
        } finally {
          await reader.cancel()
        }
      }
      return new Response(response.status === 204 ? null : Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      })
    },
    { preconnect: fetch.preconnect },
  )
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, boundedFetch)),
  )
  return new SdkOpenCodeAdapter(
    makeOpenCodeSdkClient(OpenCode.make({ baseUrl: endpoint.url }).pipe(Effect.provide(http))),
  )
}

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
              cause: new Error("Sandbox endpoint unavailable"),
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
