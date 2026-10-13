import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeCiStore } from "../src/ci/store"
import { loadConfig } from "../src/config"
import { configuredWebhookInstallations } from "../src/webhook-installations"
import { fixture, installation } from "./helpers/installation-guard"
import { GitHub } from "../src/github"
import { handleGitHubWebhook } from "../src/http"
import type { WorkflowStorePort } from "../src/store/contracts"
import type { WorkSignalPort } from "../src/work-signal"
import { WorkflowStoreLive } from "../src/store"
import { WorkSignalLive } from "../src/work-signal"
import { pullRequestPayload, signedRequest } from "./github-webhook"

const events = [
  "pull_request",
  "issue_comment",
  "workflow_run",
  "check_suite",
  "deployment_protection_rule",
  "push",
  "installation",
  "installation_repositories",
  "unknown_event",
] as const

function eventPayload(event: string, installationId: number, repository = "example-owner/example") {
  const payload = JSON.parse(pullRequestPayload())
  return JSON.stringify({
    ...payload,
    repository: { ...payload.repository, full_name: repository },
    installation: { id: installationId },
    action:
      event === "issue_comment"
        ? "created"
        : event.endsWith("run") || event === "check_suite"
          ? "completed"
          : "opened",
    issue: { number: 7, pull_request: { url: "https://api.github.test/pr/7" } },
    comment: { id: 10, body: "/agent review", user: { login: "example-owner" } },
    workflow_run: { id: 11, head_sha: "a".repeat(40), conclusion: "success" },
    check_suite: { id: 12, head_sha: "a".repeat(40), conclusion: "success" },
  })
}

function withStore<A, E>(
  program: Effect.Effect<A, E, SqlClient.SqlClient | WorkflowStorePort | WorkSignalPort>,
) {
  const database = SqliteClient.layer({ filename: ":memory:" })
  let githubCalls = 0
  const unexpectedGitHubCall = () => {
    githubCalls++
    return Effect.die("unexpected outbound GitHub call")
  }
  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          WorkflowStoreLive.pipe(Layer.provide(database)),
          database,
          WorkSignalLive,
          Layer.succeed(GitHub, {
            fetchPullRequestSnapshot: unexpectedGitHubCall,
            publishReview: unexpectedGitHubCall,
            collectHeadEvidence: unexpectedGitHubCall,
          }),
        ),
      ),
      Effect.tap(() => Effect.sync(() => expect(githubCalls).toBe(0))),
    ),
  )
}

test.each(events.map((event) => [event] as const))(
  "rejects unknown installation before storing %s",
  (event) =>
    withStore(
      Effect.gen(function* () {
        const ci = yield* makeCiStore
        const response = yield* handleGitHubWebhook(
          signedRequest(event, eventPayload(event, 999), event, "secret"),
          {
            webhookSecret: "secret",
            now: new Date(),
            installationIds: new Set([91]),
            prRepositories: [{ repository: "example-owner/example", installationId: 91 }],
            ci,
          },
        )
        expect(response.status).toBe(202)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
        expect(yield* sql`SELECT * FROM jobs`).toHaveLength(0)
        expect(yield* sql`SELECT * FROM commands`).toHaveLength(0)
        expect(yield* sql`SELECT * FROM ci_deliveries`).toHaveLength(0)
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({
          status: "ignored",
          reason: "installation-not-configured",
        })
      }),
    ),
)

test.each([
  ...events.map((event) => [event, 91, "example-owner/example"] as const),
  ["workflow_run", 92, "ci/repository"],
  ["check_suite", 92, "ci/repository"],
] as const)(
  "retains configured installation handling for %s from installation %s in %s",
  (event, installationId, repository) =>
    withStore(
      Effect.gen(function* () {
        const ci = yield* makeCiStore
        const body = eventPayload(event, installationId, repository)
        const response = yield* handleGitHubWebhook(signedRequest(event, body, event, "secret"), {
          webhookSecret: "secret",
          now: new Date(),
          prRepositories: [{ repository: "example-owner/example", installationId: 91 }],
          installationIds: new Set([91, 92]),
          ciRepositories: [
            { repository: "example-owner/example", installationId: 91 },
            { repository: "ci/repository", installationId: 92 },
          ],
          ci,
        })
        expect(response.status).toBe(202)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT payload FROM webhook_deliveries`).toEqual([{ payload: body }])
        expect(yield* sql`SELECT * FROM jobs`).toHaveLength(event === "pull_request" ? 1 : 0)
        expect(yield* sql`SELECT * FROM commands`).toHaveLength(event === "issue_comment" ? 1 : 0)
        expect(yield* sql`SELECT * FROM ci_deliveries`).toHaveLength(
          event === "workflow_run" || event === "check_suite" ? 1 : 0,
        )
      }),
    ),
)

for (const event of ["pull_request", "issue_comment", "workflow_run", "check_suite"]) {
  test.each([
    [91, "pr/repo"],
    [92, "ci/repo"],
    [91, "ci/repo"],
    [92, "pr/repo"],
    [91, "other/repo"],
    [93, "shared/repo"],
  ] as const)(`routes ${event} by installation/repository pair %s %s`, (id, repository) =>
    withStore(
      Effect.gen(function* () {
        const ci = yield* makeCiStore
        const isPr = event === "pull_request" || event === "issue_comment"
        const admitted =
          id === 93 ||
          (isPr ? id === 91 && repository === "pr/repo" : id === 92 && repository === "ci/repo")
        const response = yield* handleGitHubWebhook(
          signedRequest(event, eventPayload(event, id, repository), "pair", "secret"),
          {
            webhookSecret: "secret",
            now: new Date(),
            installationIds: new Set([91, 92, 93]),
            prRepositories: [
              { repository: "pr/repo", installationId: 91 },
              { repository: "shared/repo", installationId: 93 },
            ],
            ciRepositories: [
              { repository: "ci/repo", installationId: 92 },
              { repository: "shared/repo", installationId: 93 },
            ],
            ci,
          },
        )
        expect(response.status).toBe(202)
        if (!admitted)
          expect(yield* Effect.promise(() => response.json())).toMatchObject({ status: "ignored" })
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(admitted ? 1 : 0)
        expect(yield* sql`SELECT * FROM ci_deliveries`).toHaveLength(admitted && !isPr ? 1 : 0)
        expect(yield* sql`SELECT * FROM jobs`).toHaveLength(
          admitted && event === "pull_request" ? 1 : 0,
        )
        expect(yield* sql`SELECT * FROM commands`).toHaveLength(
          admitted && event === "issue_comment" ? 1 : 0,
        )
      }),
    ),
  )
}

test("ignores malformed foreign events before the full event decode", () =>
  withStore(
    Effect.gen(function* () {
      for (const event of events) {
        const response = yield* handleGitHubWebhook(
          signedRequest(event, '{"installation":{"id":999}}', event, "secret"),
          { webhookSecret: "secret", now: new Date(), installationIds: new Set() },
        )
        expect(response.status).toBe(202)
      }
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
    }),
  ))

test("acknowledges installation-free ping repeatedly without persistence", () =>
  withStore(
    Effect.gen(function* () {
      for (let i = 0; i < 3; i++) {
        const response = yield* handleGitHubWebhook(
          signedRequest("ping", "{}", `ping-${i}`, "secret"),
          {
            webhookSecret: "secret",
            now: new Date(),
            installationIds: new Set(),
          },
        )
        expect(response.status).toBe(202)
      }
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
    }),
  ))

test("checks HMAC before interpreting an unknown installation", async () => {
  const request = signedRequest(
    "pull_request",
    '{"installation":{"id":999}}',
    "bad-signature",
    "wrong-secret",
  )
  const response = await withStore(
    handleGitHubWebhook(request, {
      webhookSecret: "secret",
      now: new Date(),
      installationIds: new Set(),
    }),
  )
  expect(response.status).toBe(401)
})

test("installation-free or invalid installation envelopes never persist", () =>
  withStore(
    Effect.gen(function* () {
      const bodies = [
        "null",
        "[]",
        "42",
        "{}",
        '{"installation":null}',
        '{"installation":91}',
        '{"installation":{}}',
        '{"installation":{"id":"91"}}',
        '{"installation":{"id":-1}}',
        '{"installation":{"id":1.5}}',
        '{"installation":{"id":9007199254740992}}',
      ]
      for (const body of bodies) {
        const response = yield* handleGitHubWebhook(
          signedRequest("pull_request", body, body, "secret"),
          { webhookSecret: "secret", now: new Date(), installationIds: new Set() },
        )
        expect(response.status).toBe(202)
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({
          status: "ignored",
          reason: "missing-installation",
        })
      }
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
    }),
  ))

test("rejects a sandbox-only installation without storing its delivery", async () => {
  const config = await loadConfig({
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY_PATH: "/unused/key",
    GITHUB_WEBHOOK_SECRET: "secret",
    OPENCODE_SERVER_PASSWORD: "secret",
    WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
    WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
    WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232",
    WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
    WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
    WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "sandbox=/tmp/sandbox",
    WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES: JSON.stringify([
      {
        alias: "sandbox",
        repository: "sandbox/repo",
        repositoryId: 42,
        installationId: 999,
        workflowSha: "a".repeat(40),
        appActorId: 10,
        agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "f".repeat(64),
        tailscaleClientId: "fixture",
        tailscaleAudience: "fixture",
      },
    ]),
  })
  await withStore(
    Effect.gen(function* () {
      const response = yield* handleGitHubWebhook(
        signedRequest("push", eventPayload("push", 999, "sandbox/repo"), "sandbox", "secret"),
        {
          webhookSecret: "secret",
          now: new Date(),
          installationIds: configuredWebhookInstallations(config),
        },
      )
      expect(response.status).toBe(202)
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        status: "ignored",
        reason: "installation-not-configured",
      })
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
    }),
  )
})

const guardEvents = [
  ["installation", "created"],
  ["installation", "new_permissions_accepted"],
  ["installation", "unsuspend"],
  ["installation_repositories", "added"],
] as const

for (const [event, action] of guardEvents) {
  test.each([999, 81005232])(
    `guard handles unconfigured ${event}.${action} for account %s`,
    async (accountId) => {
      const f = fixture((method) =>
        method === "GET"
          ? Response.json(installation(10, accountId))
          : new Response(null, { status: 204 }),
      )
      await withStore(
        Effect.gen(function* () {
          yield* f.guard.runWebhooks.pipe(Effect.forkScoped)
          const payload = JSON.stringify({ action, installation: installation(10, accountId) })
          const send = () =>
            handleGitHubWebhook(signedRequest(event, payload, "guard", "secret"), {
              webhookSecret: "secret",
              now: new Date(),
              installationGuard: f.guard,
              installationIds: new Set([91]),
            })
          const response = yield* send()
          expect(response.status).toBe(202)
          expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "accepted" })
          yield* f.nextLog
          expect(f.requests).toEqual(
            accountId === 999
              ? ["GET /app/installations/10", "DELETE /app/installations/10"]
              : ["GET /app/installations/10"],
          )
          const duplicate = yield* send()
          expect(yield* Effect.tryPromise(() => duplicate.json())).toEqual({ status: "duplicate" })
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT payload FROM webhook_deliveries`).toEqual([{ payload }])
          expect(yield* sql`SELECT * FROM jobs`).toHaveLength(0)
          expect(yield* sql`SELECT * FROM commands`).toHaveLength(0)
        }).pipe(Effect.scoped, Effect.provide(f.logger)),
      )
    },
  )
}

test.each([
  ["installation", "deleted"],
  ["pull_request", "opened"],
])("rejects unconfigured non-guard event %s.%s without storing it", (event, action) => {
  const f = fixture()
  return withStore(
    Effect.gen(function* () {
      const payload = JSON.stringify({ ...JSON.parse(eventPayload(event, 10)), action })
      const response = yield* handleGitHubWebhook(
        signedRequest(event, payload, "non-guard", "secret"),
        {
          webhookSecret: "secret",
          now: new Date(),
          installationGuard: f.guard,
          installationIds: new Set([91]),
        },
      )
      expect(response.status).toBe(202)
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        status: "ignored",
        reason: "installation-not-configured",
      })
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
      expect(yield* sql`SELECT * FROM jobs`).toHaveLength(0)
      expect(f.requests).toEqual([])
    }),
  )
})

test("an undecodable guard event stores nothing", () => {
  const f = fixture()
  return withStore(
    Effect.gen(function* () {
      const response = yield* handleGitHubWebhook(
        signedRequest(
          "installation",
          JSON.stringify({ action: "created", installation: { id: "invalid", account: null } }),
          "malformed-guard",
          "secret",
        ),
        {
          webhookSecret: "secret",
          now: new Date(),
          installationGuard: f.guard,
          installationIds: new Set([91]),
        },
      )
      expect(response.status).toBe(500)
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM webhook_deliveries`).toHaveLength(0)
      expect(f.requests).toEqual([])
    }).pipe(Effect.provide(f.logger)),
  )
})
