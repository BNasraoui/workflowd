import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { loadConfig } from "../src/config"
import { makeLiveLayer } from "../src/layers"
import { AgentHarness } from "../src/agent-harness"
import { AgentRunProvider } from "../src/kernel/agent-run-ingress"
import { Automation, RunPullRequestAutomationInput } from "../src/opencode"

test("review availability and sessions use the reviewer URL; agent runs retain their server", async () => {
  const requests: string[] = []
  const credentials: string[] = []
  const server = (name: string) =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        requests.push(`${name}:${new URL(request.url).pathname}`)
        credentials.push(`${name}:${request.headers.get("authorization")}`)
        return new Response("fixture refusal", { status: 400 })
      },
    })
  const agents = server("agents")
  const reviewer = server("reviewer")
  const root = await mkdtemp(join(tmpdir(), "review-routing-"))
  try {
    const key = join(root, "key.pem")
    await writeFile(
      key,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    )
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        WORKFLOWD_AGENT_GIT_NAME: "Agent",
        WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example/repo","installationId":1}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: key,
        GITHUB_WEBHOOK_SECRET: "fixture",
        OPENCODE_SERVER_PASSWORD: "fixture",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-fixture",
        OPENCODE_SERVER_URL: agents.url.toString(),
        WORKFLOWD_OPENCODE_ATTACH_URL: agents.url.toString(),
        WORKFLOWD_REVIEW_OPENCODE_URL: reviewer.url.toString(),
        WORKFLOWD_AGENT_RUN_TOKEN: "fixture-run-token",
        WORKFLOWD_AGENT_RUN_ROUTES: "test=openai/test",
        WORKFLOWD_AGENT_RUN_REPOSITORIES: `fixture=${root}`,
        WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
      },
      { home: root },
    )
    const live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const automation = yield* Automation
        const harness = yield* AgentHarness
        yield* automation.validateAvailability({ fixWorkEnabled: false }).pipe(Effect.ignore)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((path) => path.startsWith("reviewer:"))).toBe(true)
        requests.length = 0
        const input = Schema.decodeUnknownSync(RunPullRequestAutomationInput)({
          directory: root,
          repositoryFullName: "example/repo",
          pullRequestNumber: 1,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
        })
        const context = {
          directory: root,
          scope: { _tag: "GenerationScope" as const, workflowId: "review", generation: 1 },
          operationId: "job:1",
          operationRevision: 1,
          attempt: 1,
          leaseToken: "a".repeat(32),
          requestedAt: new Date(),
        }
        const prepared = yield* automation.prepareReview(input, context)
        yield* harness.describe(prepared.launchIntent.harness)
        yield* harness.describe({ name: "opencode", version: 1 })
        yield* harness.createSession(prepared).pipe(Effect.ignore)
        expect(requests.some((path) => path === "reviewer:/api/session")).toBe(true)
        expect(requests.every((path) => path.startsWith("reviewer:"))).toBe(true)
        const fixed = yield* automation.prepareFix(input, context)
        yield* harness.createSession(fixed).pipe(Effect.ignore)
        const reference = {
          sessionReferenceId: prepared.launchIntent.sessionReferenceId,
          serverId: "opencode-reviewer",
          endpointAlias: "private-opencode-reviewer",
          directory: root,
          nativeSessionId: "ses_fixture",
          scope: context.scope,
          operationId: context.operationId,
          operationRevision: 1,
          attempt: 1,
          leaseToken: context.leaseToken,
          createdAt: context.requestedAt.toISOString(),
          state: "created" as const,
        }
        yield* harness.resumeSession(prepared, reference).pipe(Effect.ignore)
        requests.length = 0
        // A persisted pre-migration review stays on the server that owns its session.
        yield* harness
          .resumeSession(prepared, {
            ...reference,
            serverId: "opencode-primary",
            endpointAlias: "private-opencode",
          })
          .pipe(Effect.ignore)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((path) => path.startsWith("agents:"))).toBe(true)
        requests.length = 0
        yield* harness.abortSession(reference).pipe(Effect.ignore)
        expect(requests.every((path) => path.startsWith("reviewer:"))).toBe(true)
        requests.length = 0
        yield* harness
          .abortSession({
            ...reference,
            serverId: "opencode-primary",
            endpointAlias: "private-opencode",
          })
          .pipe(Effect.ignore)
        yield* harness
          .validateAvailability({
            selections: [
              {
                ref: { name: "opencode", version: 1 },
                agent: "remote-worker",
                model: "openai/test",
              },
            ],
          })
          .pipe(Effect.ignore)
        const provider = yield* AgentRunProvider
        yield* provider.listProviders({ directory: root }).pipe(Effect.ignore)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((path) => path.startsWith("agents:"))).toBe(true)
        for (const credential of credentials) {
          const name = credential.split(":")[0]
          const password = name === "reviewer" ? "review-fixture" : "fixture"
          expect(credential).toBe(
            `${name}:Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          )
        }
      }).pipe(Effect.provide(live)),
    )
  } finally {
    await agents.stop(true)
    await reviewer.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
