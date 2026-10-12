import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeCiStore } from "../src/ci/store"
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

function eventPayload(event: string, installationId: number) {
  return JSON.stringify({
    ...JSON.parse(pullRequestPayload()),
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

test.each(events.map((event) => [event] as const))(
  "retains configured installation handling for %s",
  (event) =>
    withStore(
      Effect.gen(function* () {
        const ci = yield* makeCiStore
        const body = eventPayload(event, 91)
        const response = yield* handleGitHubWebhook(signedRequest(event, body, event, "secret"), {
          webhookSecret: "secret",
          now: new Date(),
          prRepositories: [{ repository: "example-owner/example", installationId: 91 }],
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

test("ignores malformed foreign events before the full event decode", () =>
  withStore(
    Effect.gen(function* () {
      for (const event of events) {
        const response = yield* handleGitHubWebhook(
          signedRequest(event, '{"installation":{"id":999}}', event, "secret"),
          { webhookSecret: "secret", now: new Date() },
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
          { webhookSecret: "secret", now: new Date() },
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
