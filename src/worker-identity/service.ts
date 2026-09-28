import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Context, Effect, Layer, Redacted } from "effect"
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
  readonly provision: (run: AgentRunRecord) => Effect.Effect<string, WorkspaceError>
}
export const WorkerIdentity = Context.Service<WorkerIdentityPort>("workflowd/WorkerIdentity")
export const WorkerIdentityLive = (
  config: WorkerIdentityConfig,
  github: AppConfig["github"],
  OctokitClass: typeof Octokit = Octokit,
) =>
  Layer.effect(
    WorkerIdentity,
    Effect.gen(function* () {
      const store = yield* AgentRunStore
      const peers = new RunPeers()
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
      const provision: WorkerIdentityPort["provision"] = (run) =>
        Effect.tryPromise({
          try: async () => {
            if (run.providerId !== "codex-cli")
              throw new Error("Worker identity requires an owned Codex process tree")
            if (!config.policies.some((p) => p.name === run.repository))
              throw new Error("Repository has no worker identity policy")
            await mkdir(config.directory, { recursive: true, mode: 0o700 })
            return `For every GitHub CLI command, use: bun ${JSON.stringify(join(import.meta.dir, "command.ts"))} -- <gh arguments>. This supplies a refreshed repository-scoped App identity. For HTTPS git use --git before --. Never print tokens or use personal gh authentication.`
          },
          catch: () =>
            new WorkspaceError({
              operation: "provision worker GitHub identity",
              cause: new Error("Worker identity provisioning failed"),
            }),
        })
      const route = (request: Request, peerPid: number) =>
        Effect.gen(function* () {
          const match = /^\/workers\/github\/([^/]+)\/token$/.exec(new URL(request.url).pathname)
          if (match === null) return undefined
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const runId = decodeURIComponent(match[1]!)
          const run = yield* store.read(runId)
          if (!peers.allows(runId, peerPid) || !authorizeWorker(run, Date.now()))
            return new Response(null, { status: 403 })
          const policy = config.policies.find((p) => p.name === run!.repository)
          if (policy === undefined) return new Response(null, { status: 403 })
          const issued = yield* token(policy)
          return Response.json(
            { token: Redacted.value(issued.token), expiresAt: issued.expiresAt },
            { headers: { "cache-control": "no-store" } },
          )
        }).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 503 }))))
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          serveRunSocket(config.socket, (request, pid) => Effect.runPromise(route(request, pid))),
        ),
        (server) => Effect.tryPromise(() => server.close()).pipe(Effect.orDie),
      )
      return {
        provision,
        register: (runId, pid) => peers.register(runId, pid),
        environment: (runId) => ({
          WORKFLOWD_RUN_ID: runId,
          WORKFLOWD_WORKER_GITHUB_SOCKET: config.socket,
          GH_CONFIG_DIR: config.directory,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
        }),
      }
    }),
  )
