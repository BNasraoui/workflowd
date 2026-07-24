import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect, Either } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import { StoreDataError } from "../../src/store/errors"
import {
  changesRequestedReview,
  decodePullRequestEvent,
  runWithStore,
  sampleCommandEvent,
  samplePullRequestEvent,
} from "./harness"

describe("persisted row decoding", () => {
  test("fails pull request transitions through the typed channel for corrupt stored state", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "codec-pull-request-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`
          UPDATE pull_requests
          SET base_sha = 'invalid-sha'
          WHERE repository_id = 42
          AND pull_request_number = 7
        `
        yield* sql`PRAGMA ignore_check_constraints = OFF`

        const transition = yield* Effect.either(
          store.ingestPullRequest(
            {
              deliveryId: "codec-pull-request-transition",
              event: "pull_request",
              action: "synchronize",
              payload: "{}",
              receivedAt: new Date("2026-07-19T12:01:00.000Z"),
            },
            decodePullRequestEvent({
              ...samplePullRequestEvent,
              action: "synchronize",
              pullRequest: {
                ...samplePullRequestEvent.pullRequest,
                updatedAt: "2026-07-19T12:01:00.000Z",
              },
            }),
          ),
        )
        const deliveries = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM webhook_deliveries
          WHERE delivery_id = 'codec-pull-request-transition'
        `
        return { transition, deliveryCount: deliveries[0]?.count ?? 0 }
      }),
    )

    expect(Either.isLeft(result.transition)).toBe(true)
    if (Either.isRight(result.transition)) throw new Error("expected StoreDataError")
    expect(result.transition.left).toBeInstanceOf(StoreDataError)
    expect(result.transition.left).toMatchObject({
      field: "row",
      record: "pull_request",
      recordId: 0,
    })
    expect(result.deliveryCount).toBe(0)
  })

  test("quarantines an invalid ReviewWork row and claims the next valid row", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "poison-review-first",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "poison-review-second",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            repository: {
              ...samplePullRequestEvent.repository,
              id: 43,
              fullName: "example-owner/second",
              name: "second",
            },
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              number: 8,
            },
          }),
        )
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`
          UPDATE jobs
          SET base_sha = 'invalid-sha'
          WHERE repository_id = 42
        `
        yield* sql`PRAGMA ignore_check_constraints = OFF`

        const claimed = yield* store.claimNextJob({
          workerId: "poison-review-worker",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const rows = yield* sql<{
          readonly repository_id: number
          readonly state: string
        }>`SELECT repository_id, state FROM jobs ORDER BY id`
        return { claimed, rows }
      }),
    )

    expect(result.claimed).toMatchObject({
      _tag: "ReviewWork",
      repositoryId: 43,
    })
    expect(result.rows).toEqual([
      { repository_id: 42, state: "data_error" },
      { repository_id: 43, state: "leased" },
    ])
  })

  test("quarantines FixWork with a non-actionable review and keeps claiming", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "poison-fix-first",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "poison-fix-reviewer",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "poison-fix-reviewer",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "poison-fix-publisher",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "poison-fix-publisher",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        yield* sql`
          UPDATE jobs
          SET review_json = ${JSON.stringify({
            verdict: "changes_requested",
            summary: "Malformed finding.",
            findings: [{ severity: "unknown", title: "Bad", body: "Bad." }],
          })}
          WHERE kind = 'fix'
        `
        yield* store.ingestPullRequest(
          {
            deliveryId: "poison-fix-second",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:04:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            repository: {
              ...samplePullRequestEvent.repository,
              id: 43,
              fullName: "example-owner/second",
              name: "second",
            },
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              number: 8,
            },
          }),
        )

        const claimed = yield* store.claimNextJob({
          workerId: "poison-fix-worker",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const rows = yield* sql<{
          readonly kind: string
          readonly repository_id: number
          readonly state: string
        }>`SELECT kind, repository_id, state FROM jobs ORDER BY id`
        return { claimed, rows }
      }),
    )

    expect(result.claimed).toMatchObject({
      _tag: "ReviewWork",
      repositoryId: 43,
    })
    expect(result.rows).toContainEqual({
      kind: "fix",
      repository_id: 42,
      state: "data_error",
    })
  })

  test("quarantines corrupt publication data", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "codec-publication",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          decodePullRequestEvent({
            _tag: "PullRequest",
            action: "opened",
            installationId: 91,
            repository: {
              id: 42,
              fullName: "example-owner/example",
              name: "example",
              owner: "example-owner",
            },
            pullRequest: {
              number: 7,
              author: "opencode-agent",
              baseRef: "main",
              baseSha: "d".repeat(40),
              draft: false,
              headRef: "opencode/example-job",
              headRepositoryFullName: "example-owner/example",
              headSha: "a".repeat(40),
              state: "open",
            },
          }),
        )
        const job = yield* store.claimNextJob({
          workerId: "reviewer",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (job === null) throw new Error("expected review job")
        yield* store.completeReviewJob({
          jobId: job.id,
          workerId: "reviewer",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: { verdict: "pass", summary: "Looks good.", findings: [] },
          autoFix: false,
        })
        yield* sql`UPDATE publications SET review_json = ${JSON.stringify({
          verdict: "changes_requested",
          summary: "Malformed finding.",
          findings: [{ severity: "unknown", title: "Bad", body: "Bad." }],
        })}`

        const claimed = yield* store.claimNextPublication({
          workerId: "publisher",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const rows = yield* sql<{
          readonly last_error: string
          readonly state: string
        }>`SELECT last_error, state FROM publications`
        return { claimed, row: rows[0] }
      }),
    )

    expect(result.claimed).toBeNull()
    expect(result.row).toMatchObject({
      state: "data_error",
    })
    expect(result.row?.last_error).toContain("review_json")
  })

  test("quarantines corrupt fix-job data", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "codec-job",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review job")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        yield* sql`
          UPDATE jobs SET review_json = ${JSON.stringify({
            verdict: "changes_requested",
            summary: "Malformed finding.",
            findings: [{ severity: "unknown", title: "Bad", body: "Bad." }],
          })} WHERE kind = 'fix'
        `

        const claimed = yield* store.claimNextJob({
          workerId: "fixer",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const rows = yield* sql<{
          readonly last_error: string
          readonly state: string
        }>`SELECT last_error, state FROM jobs WHERE kind = 'fix'`
        return { claimed, row: rows[0] }
      }),
    )

    expect(result.claimed).toBeNull()
    expect(result.row).toMatchObject({ state: "data_error" })
    expect(result.row?.last_error).toContain("review_json")
  })

  test("fails command execution through the typed channel for corrupt stored data", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "codec-command-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review job")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE publications SET review_json = ${JSON.stringify({
          verdict: "pass",
          summary: "A passing review cannot contain findings.",
          findings: [{ severity: "high", title: "Contradiction", body: "Invalid." }],
        })}`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        yield* store.ingestCommand(
          {
            deliveryId: "codec-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          sampleCommandEvent("fix", 9001),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")

        return yield* Effect.either(
          store.executeCommand({
            commandId: command.id,
            workerId: "command-worker",
            authorized: true,
            fixWorkEnabled: true,
            completedAt: new Date("2026-07-19T12:04:59.999Z"),
          }),
        )
      }),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) throw new Error("expected StoreDataError")
    expect(result.left).toBeInstanceOf(StoreDataError)
    expect(result.left).toMatchObject({
      field: "review_json",
      record: "publication",
    })
  })
})
