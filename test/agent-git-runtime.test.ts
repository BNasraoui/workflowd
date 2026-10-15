import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { loadConfig } from "../src/config"
import { makeLiveLayer } from "../src/layers"
import { Automation } from "../src/opencode"
import { startHookService } from "../src/runtime"
import { agentGitTestEnvironment } from "./helpers/agent-git-config"
import { privateKey } from "./helpers/installation-guard"
import { automationStub } from "./helpers/runtime"
import { pullRequestPayload, signedRequest } from "./github-webhook"

for (const scenario of ["allowed", "blocked", "slow", "api-failure", "recovery"] as const) {
  test(`live layer/runtime identity check: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflowd-identity-runtime-"))
    const originalFetch = globalThis.fetch
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<Record<string, unknown>>()
    const checkWrites: Record<string, unknown>[] = []
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.hostname !== "api.github.com") return originalFetch(input, init)
          if (url.pathname === "/app/installations") return Response.json([])
          if (url.pathname.endsWith("/access_tokens"))
            return Response.json({ token: "fixture-token", expires_at: "2099-01-01T00:00:00Z" })
          if (url.pathname.endsWith("/pulls"))
            return Response.json(
              scenario === "recovery" ? [{ number: 7, head: { sha: "a".repeat(40) } }] : [],
            )
          if (
            url.pathname.includes("/check-runs") &&
            (init?.method ?? "GET").toUpperCase() === "GET"
          ) {
            const response = Response.json({
              total_count: 1,
              check_runs: [
                {
                  id: 12,
                  name: "Workflowd Git Identity",
                  app: { id: 123 },
                  status: "in_progress",
                  external_id: "agent-git:7",
                },
              ],
            })
            Object.defineProperty(response, "url", { value: url.toString() })
            return response
          }
          if (url.pathname.includes("/check-runs")) {
            const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
              JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
            )
            checkWrites.push(body)
            started.resolve()
            if (scenario === "api-failure")
              return Response.json({ message: "fixture unavailable" }, { status: 503 })
            if (body.status === "completed") completed.resolve(body)
            return Response.json({ id: 12 })
          }
          if (url.pathname.includes("/compare/")) {
            if (scenario === "slow")
              await Promise.race([
                release.promise,
                new Promise<void>((_, reject) =>
                  init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  }),
                ),
              ])
            const email = scenario === "blocked" ? "blocked@example.test" : "agent@example.test"
            return Response.json({
              total_commits: 1,
              commits: [
                { sha: "a".repeat(40), commit: { author: { email }, committer: { email } } },
              ],
            })
          }
          if (url.pathname.endsWith("/pulls/7"))
            return Response.json({
              number: 7,
              state: "open",
              draft: true,
              user: { login: "author" },
              base: {
                ref: "main",
                sha: "b".repeat(40),
                repo: {
                  id: 42,
                  full_name: "example-owner/example",
                  name: "example",
                  owner: { login: "example-owner" },
                },
              },
              head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "fork/example" } },
            })
          throw new Error(`Unexpected GitHub fixture request: ${url.pathname}`)
        },
        { preconnect: originalFetch.preconnect },
      ),
    )
    try {
      await writeFile(join(directory, "key.pem"), privateKey)
      const loaded = await loadConfig(
        {
          ...agentGitTestEnvironment,
          GITHUB_APP_ID: "123",
          GITHUB_PRIVATE_KEY_PATH: join(directory, "key.pem"),
          GITHUB_WEBHOOK_SECRET: "secret",
          WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232",
          WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
          OPENCODE_SERVER_PASSWORD: "password",
          WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
          WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
          WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
        },
        { home: directory },
      )
      const config = { ...loaded, http: { ...loaded.http, port: 0 } }
      const database = SqliteClient.layer({ filename: ":memory:" })
      const live = makeLiveLayer(config).pipe(Layer.provideMerge(database))
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const server = yield* startHookService(config)
          if (scenario !== "recovery") {
            const request = signedRequest(
              "pull_request",
              pullRequestPayload(),
              "runtime-identity",
              "secret",
              `http://127.0.0.1:${server.port}/hooks/github`,
            )
            const response = yield* Effect.tryPromise((signal) =>
              originalFetch(request, { signal }),
            ).pipe(Effect.timeout("2 seconds"))
            expect(response.status).toBe(202)
            expect(yield* sql`SELECT delivery_id FROM webhook_deliveries`).toEqual([
              { delivery_id: "runtime-identity" },
            ])
          }
          yield* Effect.promise(() => started.promise).pipe(Effect.timeout("2 seconds"))
          if (scenario === "slow") {
            expect(checkWrites).toHaveLength(1)
            release.resolve()
          }
          if (scenario !== "api-failure") {
            const result = yield* Effect.promise(() => completed.promise).pipe(
              Effect.timeout("2 seconds"),
            )
            expect(result).toMatchObject({
              conclusion: scenario === "blocked" ? "failure" : "success",
            })
            if (scenario === "blocked")
              expect(result.output).toMatchObject({
                summary: `${"a".repeat(40)}: author, committer`,
              })
          }
        }).pipe(
          Effect.provideService(Automation, automationStub()),
          Effect.scoped,
          Effect.provide(live),
        ),
      )
    } finally {
      release.resolve()
      fetchMock.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
