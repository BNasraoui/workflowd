import { SqlClient } from "effect/unstable/sql"
import type { OpenCodeCompletionSourceOptions } from "../kernel/opencode-completion-source"
import type { SdkOpenCodeAdapter } from "../opencode/adapter"
import { workerEnvironment } from "../resident/environment"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Cause, Context, Effect, Layer, Redacted, Schema } from "effect"
import type { AppConfig } from "../config"
import { AgentRunStore, type AgentRunRecord } from "../kernel/agent-run-store"
import { WorkspaceError } from "../workspace/errors"
import { makeTokenBroker } from "./broker"
import { authorizeWorker } from "./access"
import { RunPeers, serveRunSocket } from "./peer"
import type { WorkerIdentityConfig } from "./config"

type WorkerIdentityPort = {
  readonly environment: (runId: string) => Readonly<Record<string, string>>
  readonly register: (runId: string, pid: number) => void
  readonly nativeRun: (
    sessionId: string,
    directory: string,
  ) => Effect.Effect<string | null, WorkspaceError>
  readonly bindSession: (runId: string, sessionId: string) => string
  readonly revoke: (runId: string) => void
  readonly provision: (run: AgentRunRecord) => Effect.Effect<string, WorkspaceError>
}
export const WorkerIdentity = Context.Service<WorkerIdentityPort>("workflowd/WorkerIdentity")
export const WorkerIdentityLive = (
  config: WorkerIdentityConfig,
  github: NonNullable<AppConfig["github"]>,
  OctokitClass: typeof Octokit = Octokit,
  openCode?: Pick<SdkOpenCodeAdapter, "setSessionEnvironment"> &
    Omit<OpenCodeCompletionSourceOptions, "now" | "observationTimeoutMs">,
) =>
  Layer.effect(
    WorkerIdentity,
    Effect.gen(function* () {
      const store = yield* AgentRunStore
      const sql = yield* SqlClient.SqlClient
      const sessionCustody = (runId?: string) => sql`SELECT a.run_id FROM kernel_agent_runs a
        JOIN kernel_sessions s ON s.session_id=a.session_id AND s.native_session_id=a.native_session_id
        JOIN kernel_working_resources r ON r.resource_id=s.resource_id AND r.resource_id=a.resource_id AND r.absolute_path=a.directory
        WHERE (${runId ?? null} IS NULL OR a.run_id=${runId ?? null}) AND s.provider_kind='opencode' AND s.server_id=${openCode?.serverId ?? ""}
        AND s.owning_host_id=${openCode?.owningHostId ?? ""} AND r.owning_host_id=s.owning_host_id
        AND s.provider_id=${openCode?.providerId ?? ""} AND s.provider_version=${openCode?.providerVersion ?? 0}
        AND s.endpoint_alias=${openCode?.endpointAlias ?? ""} AND s.endpoint_identity=${openCode?.endpointIdentity ?? ""}
        AND a.state IN ('spawning','spawned','verified') AND s.state IN ('ready','active') AND r.state='reserved'`
      const peers = new RunPeers()
      const sessions = new Map<string, { sessionId: string; hash: Buffer }>()
      const digest = (value: string) => createHash("sha256").update(value).digest()
      const SessionRequest = Schema.Struct({
        sessionId: Schema.String,
        capability: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      })
      const key = yield* Effect.tryPromise(() => readFile(github.privateKeyPath, "utf8"))
      const app = new App({ appId: github.appId, privateKey: key, Octokit: OctokitClass })
      const token = yield* makeTokenBroker(
        async (input) =>
          (
            await app.octokit.request(
              "POST /app/installations/{installation_id}/access_tokens",
              input,
            )
          ).data,
      )
      const environment: WorkerIdentityPort["environment"] = (runId) => ({
        WORKFLOWD_RUN_ID: runId,
        WORKFLOWD_WORKER_GITHUB_SOCKET: config.socket,
        GH_CONFIG_DIR: config.home ? join(config.home, ".config/gh") : config.directory,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      })
      const bindSession: WorkerIdentityPort["bindSession"] = (runId, sessionId) => {
        peers.revoke(runId)
        const capability = randomBytes(32).toString("hex")
        sessions.set(runId, { sessionId, hash: digest(capability) })
        return capability
      }
      const prepareSession = (run: AgentRunRecord) =>
        Effect.gen(function* () {
          if (!openCode || !run.nativeSessionId)
            return yield* Effect.fail(new Error("OpenCode worker session unavailable"))
          if ((yield* sessionCustody(run.runId)).length !== 1)
            return yield* Effect.fail(new Error("OpenCode worker custody unavailable"))
          const capability = bindSession(run.runId, run.nativeSessionId)
          yield* openCode.setSessionEnvironment({
            sessionID: run.nativeSessionId,
            variables: {
              ...workerEnvironment(),
              ...environment(run.runId),
              WORKFLOWD_WORKER_SESSION_ID: run.nativeSessionId,
              WORKFLOWD_WORKER_CAPABILITY: capability,
            },
          })
        })
      const provision: WorkerIdentityPort["provision"] = (run) =>
        Effect.gen(function* () {
          if (!config.policies.some((p) => p.name === run.repository))
            return yield* Effect.fail(new Error("Repository has no worker identity policy"))
          yield* Effect.tryPromise(() => mkdir(config.directory, { recursive: true, mode: 0o700 }))
          if (!["codex-cli", "claude-cli"].includes(run.providerId)) yield* prepareSession(run)
          return `For every GitHub CLI command, use: bun ${JSON.stringify(config.command ?? join(import.meta.dir, "command.ts"))} -- <gh arguments>. This supplies a refreshed repository-scoped App identity. For HTTPS git use --git before --. Never print tokens or use personal gh authentication.`
        }).pipe(
          Effect.mapError(
            () =>
              new WorkspaceError({
                operation: "provision worker GitHub identity",
                cause: new Error("Worker identity provisioning failed"),
              }),
          ),
        )
      const route = (request: Request, peerPid: number) =>
        Effect.gen(function* () {
          const match = /^\/workers\/github\/([^/]+)\/token$/.exec(new URL(request.url).pathname)
          if (match === null) return undefined
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const runId = decodeURIComponent(match[1]!)
          const run = yield* store.read(runId)
          if (!authorizeWorker(run, Date.now())) return new Response(null, { status: 403 })
          const session = sessions.get(runId)
          if (session) {
            if ((yield* sessionCustody(runId)).length !== 1)
              return new Response(null, { status: 403 })
            const input = yield* Effect.tryPromise(async () =>
              Schema.decodeUnknownSync(SessionRequest)(await request.json()),
            ).pipe(Effect.catch(() => Effect.succeed(null)))
            if (
              !input ||
              input.sessionId !== session.sessionId ||
              run?.nativeSessionId !== session.sessionId ||
              !timingSafeEqual(digest(input.capability), session.hash)
            )
              return new Response(null, { status: 403 })
          } else if (!peers.allows(runId, peerPid)) return new Response(null, { status: 403 })
          const policy = config.policies.find((p) => p.name === run!.repository)
          if (policy === undefined) return new Response(null, { status: 403 })
          const issued = yield* token(policy)
          return Response.json(
            { token: Redacted.value(issued.token), expiresAt: issued.expiresAt },
            { headers: { "cache-control": "no-store" } },
          )
        }).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 503 }))))
      if (openCode) {
        const rows = yield* sessionCustody()
        for (const value of rows) {
          const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ run_id: Schema.String }))(
            value,
          )
          const run = yield* store.read(row.run_id)
          if (run && authorizeWorker(run, Date.now()))
            yield* prepareSession(run).pipe(
              Effect.timeout("10 seconds"),
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                sessions.delete(run.runId)
                return Effect.logWarning(
                  "OpenCode worker identity recovery failed; run left unbound",
                  {
                    runId: run.runId,
                  },
                )
              }),
            )
        }
      }
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          serveRunSocket(
            config.socket,
            (request, pid) => Effect.runPromise(route(request, pid)),
            config.peer,
          ),
        ),
        (server) => Effect.tryPromise(() => server.close()).pipe(Effect.orDie),
      )
      return {
        provision,
        nativeRun: (sessionId, directory) =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT a.run_id FROM kernel_agent_runs a JOIN kernel_sessions s ON s.session_id=a.session_id AND s.native_session_id=a.native_session_id
            JOIN kernel_working_resources r ON r.resource_id=s.resource_id AND r.resource_id=a.resource_id AND r.absolute_path=a.directory AND r.state='reserved'
            WHERE s.native_session_id=${sessionId} AND s.provider_kind='claude' AND a.directory=${directory} AND a.state IN ('spawning','spawned','verified') AND s.state IN ('ready','active')`
            if (rows.length !== 1) return null
            const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ run_id: Schema.String }))(
              rows[0],
            )
            const run = yield* store.read(row.run_id)
            return authorizeWorker(run, Date.now()) ? row.run_id : null
          }).pipe(
            Effect.mapError(
              () =>
                new WorkspaceError({
                  operation: "resolve native worker binding",
                  cause: new Error("Native worker binding unavailable"),
                }),
            ),
          ),
        register: (runId, pid) => {
          sessions.delete(runId)
          peers.register(runId, pid)
        },
        bindSession,
        revoke: (runId) => {
          peers.revoke(runId)
          sessions.delete(runId)
        },
        environment,
      }
    }),
  )
