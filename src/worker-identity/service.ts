import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Context, Effect, Layer, Redacted } from "effect"
import type { AppConfig } from "../config"
import { AgentRunStore, type AgentRunRecord } from "../kernel/agent-run-store"
import { WorkspaceError } from "../workspace/errors"
import { makeTokenBroker } from "./broker"
import { authorizeWorker, workerCapability } from "./access"
import type { WorkerIdentityConfig } from "./config"

type WorkerIdentityPort = {
  readonly environment: Readonly<Record<string, string>>
  readonly provision: (run: AgentRunRecord) => Effect.Effect<string, WorkspaceError>
  readonly route: (request: Request) => Effect.Effect<Response | undefined>
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
            if (!config.policies.some((p) => p.name === run.repository))
              throw new Error("Repository has no worker identity policy")
            await mkdir(config.directory, { recursive: true, mode: 0o700 })
            const path = join(
              config.directory,
              `${createHash("sha256").update(run.runId).digest("hex")}.json`,
            )
            await writeFile(
              path,
              JSON.stringify({
                endpoint: config.endpoint,
                runId: run.runId,
                capability: workerCapability(config.secret, run.runId),
              }),
              { mode: 0o600 },
            )
            // Only the private file path enters the prompt; no token enters argv or logs.
            return `For every GitHub CLI command, use: bun ${JSON.stringify(join(import.meta.dir, "command.ts"))} --identity ${JSON.stringify(path)} -- <gh arguments>. This supplies a refreshed repository-scoped App identity. Do not use personal gh authentication. For HTTPS git commands use the same wrapper with --git before --. Never print the identity file or tokens.`
          },
          catch: () =>
            new WorkspaceError({
              operation: "provision worker GitHub identity",
              cause: new Error("Worker identity provisioning failed"),
            }),
        })
      const route: WorkerIdentityPort["route"] = (request) =>
        Effect.gen(function* () {
          const match = /^\/workers\/github\/([^/]+)\/token$/.exec(new URL(request.url).pathname)
          if (match === null) return undefined
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const runId = decodeURIComponent(match[1]!)
          const run = yield* store.read(runId)
          const cap = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
          if (!authorizeWorker(config.secret, runId, cap, run, Date.now()))
            return new Response(null, { status: 403 })
          const policy = config.policies.find((p) => p.name === run!.repository)
          if (policy === undefined) return new Response(null, { status: 403 })
          const issued = yield* token(policy)
          return Response.json(
            { token: Redacted.value(issued.token), expiresAt: issued.expiresAt },
            { headers: { "cache-control": "no-store" } },
          )
        }).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 503 }))))
      return {
        provision,
        route,
        environment: {
          GH_CONFIG_DIR: config.directory,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
        },
      }
    }),
  )
