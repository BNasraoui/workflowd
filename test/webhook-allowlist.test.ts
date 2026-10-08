import { expect, test } from "bun:test"
import { signedRequest } from "./github-webhook"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { handleGitHubWebhook } from "../src/http"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore } from "../src/store/contracts"
import { WorkSignalLive } from "../src/work-signal"

const repositories = [
  { repository: "example-owner/example", installationId: 91 },
  { repository: "example-owner/second", installationId: 92 },
]
const now = new Date("2026-10-07T00:00:00Z")
const DatabaseLive = SqliteClient.layer({ filename: ":memory:" })
const TestLayer = Layer.mergeAll(
  WorkflowStoreLive.pipe(Layer.provide(DatabaseLive)),
  DatabaseLive,
  WorkSignalLive,
)

function request(event: string, installationId: number, repository: string) {
  const [owner, name] = repository.split("/")
  const body = JSON.stringify({
    action: event === "pull_request" ? "opened" : "created",
    installation: { id: installationId },
    repository: { id: 42, full_name: repository, owner: { login: owner }, name },
    pull_request: {
      number: 7,
      state: "open",
      user: { login: "opencode-agent" },
      head: { sha: "a".repeat(40), ref: "opencode/test", repo: { full_name: repository } },
      base: { sha: "b".repeat(40), ref: "main" },
    },
    issue: { number: 7, pull_request: { url: "https://api.github.test/pr/7" } },
    comment: { id: 10, body: "/agent review", user: { login: owner } },
  })
  return signedRequest(event, body, "allowlist-delivery", "secret")
}

test.each([
  ["pull_request", 999, "example-owner/example", repositories],
  ["pull_request", 91, "foreign/repository", repositories],
  ["pull_request", 91, "example-owner/second", repositories],
  ["issue_comment", 91, "foreign/repository", repositories],
  ["issue_comment", 999, "example-owner/example", repositories],
  ["pull_request", 91, "example-owner/example", []],
  ["issue_comment", 91, "example-owner/example", undefined],
])(
  "ignores unconfigured %s from installation %s repository %s",
  async (event, id, repo, allowed) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const options = {
          webhookSecret: "secret",
          now,
          ...(allowed === undefined ? {} : { prRepositories: allowed }),
        }
        const response = yield* handleGitHubWebhook(request(event, id, repo), options)
        expect(response.status).toBe(202)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          status: "ignored",
          reason: "pr-repository-not-allowlisted",
        })
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT delivery_id FROM webhook_deliveries`).toEqual([
          { delivery_id: "allowlist-delivery" },
        ])
        expect(yield* sql`SELECT * FROM pull_requests`).toEqual([])
        expect(yield* sql`SELECT * FROM jobs`).toEqual([])
        expect(yield* sql`SELECT * FROM commands`).toEqual([])
        const duplicate = yield* handleGitHubWebhook(request(event, id, repo), options)
        expect(yield* Effect.promise(() => duplicate.json())).toEqual({ status: "duplicate" })
      }).pipe(Effect.provide(TestLayer)),
    )
  },
)

test.each([
  [91, "Example-Owner/Example"],
  [92, "example-owner/second"],
])("configured repository %s %s still queues reviews", async (id, repo) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* handleGitHubWebhook(request("pull_request", id, repo), {
        webhookSecret: "secret",
        now,
        prRepositories: repositories,
      })
      expect(yield* Effect.promise(() => response.json())).toEqual({
        status: "enqueued",
        generation: 1,
      })
      const store = yield* WorkflowStore
      const job = yield* store.claimNextJob({ workerId: "test", now, leaseDurationMs: 60_000 })
      expect(String(job?.target.headSha)).toBe("a".repeat(40))
    }).pipe(Effect.provide(TestLayer)),
  )
})
