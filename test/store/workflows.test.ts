import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import {
  changesRequestedReview,
  decodePullRequestEvent,
  makeStoreLayer,
  sampleCommandEvent,
  samplePullRequestEvent,
} from "./harness"

const TestLayer = makeStoreLayer()

describe("WorkflowStore.recordDelivery", () => {
  test("durably deduplicates a GitHub delivery ID", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const delivery = {
          deliveryId: "delivery-1",
          event: "pull_request",
          action: "opened",
          payload: '{"action":"opened"}',
          receivedAt: new Date("2026-07-19T12:00:00.000Z"),
        } as const

        return [
          yield* store.recordDelivery(delivery),
          yield* store.recordDelivery(delivery),
        ]
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(results).toEqual(["inserted", "duplicate"])
  })
})

describe("WorkflowStore.ingestPullRequest", () => {
  test("atomically creates one review job for an eligible delivery", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const event = decodePullRequestEvent({
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
        })
        const delivery = {
          deliveryId: "delivery-pr-1",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-19T12:00:00.000Z"),
        } as const

        const ingested = yield* store.ingestPullRequest(delivery, event)
        const claimed = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const duplicate = yield* store.ingestPullRequest(delivery, event)

        return { claimed, duplicate, ingested }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.ingested).toEqual({ status: "enqueued", generation: 1 })
    expect(result.claimed).toMatchObject({
      _tag: "ReviewWork",
      generation: 1,
      pullRequestNumber: 7,
      repositoryFullName: "example-owner/example",
      target: {
        baseRef: "main",
        baseSha: "d".repeat(40),
        headRef: "opencode/example-job",
        headSha: "a".repeat(40),
      },
    })
    expect(result.duplicate).toEqual({ status: "duplicate" })
  })

  test("supersedes a running review when the PR head changes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const baseEvent = decodePullRequestEvent({
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
            updatedAt: "2026-07-19T12:00:00.000Z",
          },
        })
        const firstDelivery = {
          deliveryId: "delivery-pr-old",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-19T12:00:00.000Z"),
        } as const

        yield* store.ingestPullRequest(firstDelivery, baseEvent)
        const first = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (first === null) throw new Error("expected first job")

        const nextEvent = decodePullRequestEvent({
          ...baseEvent,
          action: "synchronize",
          pullRequest: {
            ...baseEvent.pullRequest,
            headSha: "b".repeat(40),
            updatedAt: "2026-07-19T12:02:00.000Z",
          },
        })
        yield* store.ingestPullRequest(
          {
            ...firstDelivery,
            action: "synchronize",
            deliveryId: "delivery-pr-new",
            receivedAt: new Date("2026-07-19T12:02:00.000Z"),
          },
          nextEvent,
        )

        const shouldCancel = yield* store.shouldCancelJob(
          first.id,
          "worker-1",
          new Date("2026-07-19T12:02:00.000Z"),
        )
        const second = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { second, shouldCancel }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.shouldCancel).toBe(true)
    expect(result.second).toMatchObject({
      target: { headSha: "b".repeat(40) },
      generation: 2,
    })
  })
})

describe("WorkflowStore.completeReviewJob", () => {
  test("atomically completes a current job and creates one publication", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const event = decodePullRequestEvent({
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
        })
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-complete",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          event,
        )
        const job = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (job === null) throw new Error("expected job")
        const review = changesRequestedReview

        const completed = yield* store.completeReviewJob({
          jobId: job.id,
          workerId: "worker-1",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review,
          autoFix: true,
        })
        const blockedFix = yield* store.claimNextJob({
          workerId: "fixer-1",
          now: new Date("2026-07-19T12:02:30.000Z"),
          leaseDurationMs: 60_000,
        })
        const repeated = yield* store.completeReviewJob({
          jobId: job.id,
          workerId: "worker-1",
          completedAt: new Date("2026-07-19T12:02:01.000Z"),
          review,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-1",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        const publicationDisposition = yield* store.reschedulePublication({
          publicationId: publication.id,
          workerId: "publisher-1",
          failedAt: new Date("2026-07-19T12:03:30.000Z"),
          runAt: new Date("2026-07-19T12:10:00.000Z"),
          error: "temporary GitHub failure",
          maxAttempts: 3,
        })
        const earlyPublication = yield* store.claimNextPublication({
          workerId: "publisher-1",
          now: new Date("2026-07-19T12:09:59.000Z"),
          leaseDurationMs: 60_000,
        })
        const retriedPublication = yield* store.claimNextPublication({
          workerId: "publisher-1",
          now: new Date("2026-07-19T12:10:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (retriedPublication === null) throw new Error("expected retried publication")
        const published = yield* store.completePublication({
          publicationId: retriedPublication.id,
          workerId: "publisher-1",
          completedAt: new Date("2026-07-19T12:10:59.999Z"),
          outcome: "published",
        })
        const fixJob = yield* store.claimNextJob({
          workerId: "fixer-1",
          now: new Date("2026-07-19T12:11:30.000Z"),
          leaseDurationMs: 60_000,
        })
        if (fixJob === null) throw new Error("expected fix job")
        const fixCompleted = yield* store.completeFixJob({
          jobId: fixJob.id,
          workerId: "fixer-1",
          completedAt: new Date("2026-07-19T12:11:45.000Z"),
        })
        const remaining = yield* store.claimNextPublication({
          workerId: "publisher-1",
          now: new Date("2026-07-19T12:12:00.000Z"),
          leaseDurationMs: 60_000,
        })

        return {
          completed,
          blockedFix,
          earlyPublication,
          fixCompleted,
          fixJob,
          publication,
          publicationDisposition,
          published,
          remaining,
          repeated,
          retriedPublication,
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.completed).toBe("completed")
    expect(result.blockedFix).toBeNull()
    expect(result.fixCompleted).toBe("completed")
    expect(result.fixJob).toMatchObject({
      _tag: "FixWork",
      generation: 1,
      review: { verdict: "changes_requested" },
    })
    expect(result.repeated).toBe("stale")
    expect(result.publicationDisposition).toBe("retry")
    expect(result.earlyPublication).toBeNull()
    expect(Number(result.retriedPublication.attempt)).toBe(2)
    expect(result.published).toBe("completed")
    expect(result.remaining).toBeNull()
    expect(result.publication).toMatchObject({
      operationKey: "review:42:7:1",
      pullRequestNumber: 7,
      repositoryFullName: "example-owner/example",
      target: {
        baseRef: "main",
        baseSha: "d".repeat(40),
        headRef: "opencode/example-job",
        headRepositoryFullName: "example-owner/example",
        headSha: "a".repeat(40),
      },
      review: { verdict: "changes_requested" },
    })
  })
})

describe("publication and claim invariants", () => {
  test("does not release auto-fix work until its review publication is sent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-publication-gate-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer-publication-gate",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer-publication-gate",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const beforePublication = yield* store.claimNextJob({
          workerId: "fixer-publication-gate",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-publication-gate",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        const completed = yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher-publication-gate",
          completedAt: new Date("2026-07-19T12:04:59.999Z"),
          outcome: "published",
        })
        const afterPublication = yield* store.claimNextJob({
          workerId: "fixer-publication-gate",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { afterPublication, beforePublication, completed }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.beforePublication).toBeNull()
    expect(result.completed).toBe("completed")
    expect(result.afterPublication).toMatchObject({ _tag: "FixWork" })
  })

  test("marks a stale publication outcome superseded instead of sent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-stale-publication-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer-stale-publication",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer-stale-publication",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-stale-publication",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        const completed = yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher-stale-publication",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "stale",
        })
        const publicationRetry = yield* store.claimNextPublication({
          workerId: "publisher-stale-publication",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const fix = yield* store.claimNextJob({
          workerId: "fixer-stale-publication",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const rows = yield* sql<{ readonly last_error: string }>`
          SELECT last_error FROM publications WHERE id = ${publication.id}
        `
        return { completed, fix, publicationRetry, reason: rows[0]?.last_error }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.completed).toBe("stale")
    expect(result.reason).toBe("publication superseded")
    expect(result.publicationRetry).toBeNull()
    expect(result.fix).toBeNull()
  })

  test("does not complete a publication that became generation-stale", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-generation-stale-publication-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer-generation-stale-publication",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer-generation-stale-publication",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-generation-stale",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* sql`
          UPDATE pull_requests
          SET generation = generation + 1, head_sha = ${"b".repeat(40)}
          WHERE repository_id = 42 AND pull_request_number = 7
        `
        const completed = yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher-generation-stale",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        const fix = yield* store.claimNextJob({
          workerId: "fixer-generation-stale",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { completed, fix }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.completed).toBe("stale")
    expect(result.fix).toBeNull()
  })

  test("central claim skips a command-created review when the PR is no longer eligible", async () => {
    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-central-claim-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const firstReview = yield* store.claimNextJob({
          workerId: "reviewer-central-claim",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstReview === null) throw new Error("expected first review")
        yield* store.completeReviewJob({
          jobId: firstReview.id,
          workerId: "reviewer-central-claim",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-central-claim-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          sampleCommandEvent("review", 3001),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-central-claim",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-central-claim",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:04:59.999Z"),
        })
        yield* sql`
          UPDATE pull_requests
          SET draft = TRUE
          WHERE repository_id = 42 AND pull_request_number = 7
        `
        return yield* store.claimNextJob({
          workerId: "reviewer-central-claim-2",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(claimed).toBeNull()
  })

  test("atomically rejects review completion after the PR becomes stale", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-stale-completion-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer-stale-completion",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* sql`
          UPDATE pull_requests
          SET state = 'closed'
          WHERE repository_id = 42 AND pull_request_number = 7
        `
        const completed = yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer-stale-completion",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-stale-completion",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const fix = yield* store.claimNextJob({
          workerId: "fixer-stale-completion",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { completed, fix, publication }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.completed).toBe("stale")
    expect(result.publication).toBeNull()
    expect(result.fix).toBeNull()
  })

  test("supersedes a claimed old publication when an explicit re-review starts", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-publication-revision-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const firstReview = yield* store.claimNextJob({
          workerId: "reviewer-publication-revision-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstReview === null) throw new Error("expected first review")
        yield* store.completeReviewJob({
          jobId: firstReview.id,
          workerId: "reviewer-publication-revision-1",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        const oldPublication = yield* store.claimNextPublication({
          workerId: "publisher-publication-revision-1",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (oldPublication === null) throw new Error("expected old publication")
        const oldCurrentBefore = yield* store.isPublicationCurrent(
          oldPublication.id,
          "publisher-publication-revision-1",
          new Date("2026-07-19T12:03:30.000Z"),
        )
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-publication-revision-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:04:00.000Z"),
          },
          sampleCommandEvent("review", 3002),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-publication-revision",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-publication-revision",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:05:59.999Z"),
        })
        const oldCurrentAfter = yield* store.isPublicationCurrent(
          oldPublication.id,
          "publisher-publication-revision-1",
          new Date("2026-07-19T12:06:30.000Z"),
        )
        const oldCompletion = yield* store.completePublication({
          publicationId: oldPublication.id,
          workerId: "publisher-publication-revision-1",
          completedAt: new Date("2026-07-19T12:07:00.000Z"),
          outcome: "published",
        })
        const secondReview = yield* store.claimNextJob({
          workerId: "reviewer-publication-revision-2",
          now: new Date("2026-07-19T12:08:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (secondReview === null) throw new Error("expected second review")
        yield* store.completeReviewJob({
          jobId: secondReview.id,
          workerId: "reviewer-publication-revision-2",
          completedAt: new Date("2026-07-19T12:08:59.999Z"),
          review: {
            verdict: "pass",
            summary: "The replacement review passes.",
            findings: [],
          },
          autoFix: false,
        })
        const newPublication = yield* store.claimNextPublication({
          workerId: "publisher-publication-revision-2",
          now: new Date("2026-07-19T12:10:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return {
          newPublication,
          oldCompletion,
          oldCurrentAfter,
          oldCurrentBefore,
          secondReview,
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.oldCompletion).toBe("stale")
    expect(result.oldCurrentBefore).toBe(true)
    expect(result.oldCurrentAfter).toBe(false)
    expect(Number(result.secondReview.reviewRequestNumber)).toBe(2)
    expect(result.newPublication?.operationKey).toBe("review:42:7:1:2")
  })

  test("central claim skips an old-revision fix after explicit re-review", async () => {
    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-fix-revision-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const firstReview = yield* store.claimNextJob({
          workerId: "reviewer-fix-revision",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstReview === null) throw new Error("expected first review")
        yield* store.completeReviewJob({
          jobId: firstReview.id,
          workerId: "reviewer-fix-revision",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-fix-revision",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher-fix-revision",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-fix-revision-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:05:00.000Z"),
          },
          sampleCommandEvent("review", 3003),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-fix-revision",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-fix-revision",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:06:59.999Z"),
        })
        return yield* store.claimNextJob({
          workerId: "reviewer-fix-revision-2",
          now: new Date("2026-07-19T12:08:00.000Z"),
          leaseDurationMs: 60_000,
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(claimed).toMatchObject({
      _tag: "ReviewWork",
      reviewRequestNumber: 2,
    })
  })

  test("cancels and rejects completion of a non-latest Review Request", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-non-latest-completion-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const firstReview = yield* store.claimNextJob({
          workerId: "reviewer-non-latest",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstReview === null) throw new Error("expected first review")
        yield* sql`
          INSERT INTO jobs (
            kind, installation_id, repository_id, repository_full_name,
            pull_request_number, author, base_ref, base_sha,
            expected_head_sha, head_ref, head_repository_full_name, generation,
            review_request_number, state, run_at, created_at, updated_at
          )
          SELECT
            kind, installation_id, repository_id, repository_full_name,
            pull_request_number, author, base_ref, base_sha,
            expected_head_sha, head_ref, head_repository_full_name, generation,
            review_request_number + 1, 'ready', run_at, created_at, updated_at
          FROM jobs
          WHERE id = ${firstReview.id}
        `

        const shouldCancel = yield* store.shouldCancelJob(
          firstReview.id,
          "reviewer-non-latest",
          new Date("2026-07-19T12:01:30.000Z"),
        )
        const completed = yield* store.completeReviewJob({
          jobId: firstReview.id,
          workerId: "reviewer-non-latest",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        return { completed, shouldCancel }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.shouldCancel).toBe(true)
    expect(result.completed).toBe("stale")
  })

  test("does not manually fix a Publication for a stale Review Target", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-stale-target-fix-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "reviewer-stale-target-fix",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "reviewer-stale-target-fix",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-stale-target-fix",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher-stale-target-fix",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        yield* sql`
          UPDATE publications SET base_ref = 'stale-base'
          WHERE id = ${publication.id}
        `
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-stale-target-fix-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:05:00.000Z"),
          },
          sampleCommandEvent("fix", 3004),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-stale-target-fix",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        const disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-stale-target-fix",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:06:59.999Z"),
        })
        const fixes = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM jobs WHERE kind = 'fix'
        `
        return { disposition, fixCount: fixes[0]?.count }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toBe("noop")
    expect(result.fixCount).toBe(0)
  })
})

describe("WorkflowStore.ingestCommand", () => {
  test("durably queues a PR command for authorization", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-command-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T11:59:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const event = sampleCommandEvent("review", 1001)
        const delivery = {
          deliveryId: "delivery-command-1",
          event: "issue_comment",
          action: "created",
          payload: "{}",
          receivedAt: new Date("2026-07-19T12:00:00.000Z"),
        } as const

        const ingested = yield* store.ingestCommand(delivery, event)
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        const disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-1",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
        })
        const remaining = yield* store.claimNextCommand({
          workerId: "command-worker-1",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { command, disposition, ingested, remaining }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.ingested).toEqual({ status: "enqueued" })
    expect(result.command).toMatchObject({
      command: "review",
      commentId: 1001,
      commenter: "example-owner",
      pullRequestNumber: 7,
      repositoryFullName: "example-owner/example",
    })
    expect(result.disposition).toBe("noop")
    expect(result.remaining).toBeNull()
  })
})

describe("WorkflowStore.executeCommand workflows", () => {
  test("rejects an authorized command when the current PR is closed", async () => {
    const disposition = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-command-closed-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-command-close",
            event: "pull_request",
            action: "closed",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "closed",
            pullRequest: { ...samplePullRequestEvent.pullRequest, state: "closed" },
          }),
        )
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-command-closed",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:02:00.000Z"),
          },
          sampleCommandEvent("review", 2001),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-closed",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        return yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-closed",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(disposition).toBe("stale")
  })

  test("reports status as a no-op rather than an action", async () => {
    const disposition = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-status-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-status-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:00.000Z"),
          },
          sampleCommandEvent("status", 2002),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-status",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        return yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-status",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:02:59.999Z"),
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(disposition).toBe("noop")
  })

  test("rejects fix commands for fork pull requests", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-fork-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headRepositoryFullName: "contributor/example",
            },
          }),
        )
        const reviewJob = yield* store.claimNextJob({
          workerId: "reviewer-fork",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reviewJob === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: reviewJob.id,
          workerId: "reviewer-fork",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-fork-fix",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          sampleCommandEvent("fix", 2003),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-fork",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        const disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-fork",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:04:59.999Z"),
        })
        const fix = yield* store.claimNextJob({
          workerId: "fixer-fork",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, fix }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toBe("denied")
    expect(result.fix).toBeNull()
  })

  test("does not enqueue a fix without actionable current findings", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-empty-findings-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const reviewJob = yield* store.claimNextJob({
          workerId: "reviewer-empty",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reviewJob === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: reviewJob.id,
          workerId: "reviewer-empty",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: {
            verdict: "pass",
            summary: "No actionable findings.",
            findings: [],
          },
          autoFix: false,
        })
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-empty-findings-fix",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          sampleCommandEvent("fix", 2004),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-empty",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        const disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-empty",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:04:59.999Z"),
        })
        const fix = yield* store.claimNextJob({
          workerId: "fixer-empty",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, fix }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toBe("noop")
    expect(result.fix).toBeNull()
  })

  test("requeues a failed current-generation fix job", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-requeue-fix-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const reviewJob = yield* store.claimNextJob({
          workerId: "reviewer-requeue-fix",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reviewJob === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: reviewJob.id,
          workerId: "reviewer-requeue-fix",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "publisher-requeue-fix",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "publisher-requeue-fix",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })

        const runFixCommand = (deliveryId: string, commentId: number, minute: number) =>
          Effect.gen(function* () {
            const minuteText = String(minute).padStart(2, "0")
            yield* store.ingestCommand(
              {
                deliveryId,
                event: "issue_comment",
                action: "created",
                payload: "{}",
                receivedAt: new Date(`2026-07-19T12:${minuteText}:00.000Z`),
              },
              sampleCommandEvent("fix", commentId),
            )
            const command = yield* store.claimNextCommand({
              workerId: "command-worker-requeue-fix",
              now: new Date(`2026-07-19T12:${minuteText}:30.000Z`),
              leaseDurationMs: 60_000,
            })
            if (command === null) throw new Error("expected command")
            return yield* store.executeCommand({
              commandId: command.id,
              workerId: "command-worker-requeue-fix",
              authorized: true,
              fixWorkEnabled: true,
              completedAt: new Date(`2026-07-19T12:${minuteText}:45.000Z`),
            })
          })

        const firstDisposition = yield* runFixCommand(
          "delivery-requeue-fix-command-1",
          2005,
          5,
        )
        const firstFix = yield* store.claimNextJob({
          workerId: "fixer-requeue-1",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstFix === null) throw new Error("expected first fix")
        yield* store.rescheduleJob({
          jobId: firstFix.id,
          workerId: "fixer-requeue-1",
          failedAt: new Date("2026-07-19T12:06:30.000Z"),
          runAt: new Date("2026-07-19T12:07:00.000Z"),
          error: "fix failed",
          maxAttempts: 1,
        })
        const secondDisposition = yield* runFixCommand(
          "delivery-requeue-fix-command-2",
          2006,
          7,
        )
        const secondFix = yield* store.claimNextJob({
          workerId: "fixer-requeue-2",
          now: new Date("2026-07-19T12:08:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { firstDisposition, firstFix, secondDisposition, secondFix }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.firstDisposition).toBe("fix")
    expect(result.secondDisposition).toBe("fix")
    expect(result.secondFix).toMatchObject({
      id: result.firstFix.id,
      _tag: "FixWork",
      attempt: 1,
    })
  })

  test("creates a new publication operation for an explicit re-review", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-rereview-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const firstReview = yield* store.claimNextJob({
          workerId: "reviewer-rereview-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstReview === null) throw new Error("expected first review")
        yield* store.completeReviewJob({
          jobId: firstReview.id,
          workerId: "reviewer-rereview-1",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        const firstPublication = yield* store.claimNextPublication({
          workerId: "publisher-rereview-1",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (firstPublication === null) throw new Error("expected first publication")
        yield* store.completePublication({
          publicationId: firstPublication.id,
          workerId: "publisher-rereview-1",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-rereview-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:05:00.000Z"),
          },
          sampleCommandEvent("review", 2007),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker-rereview",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        const disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker-rereview",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: new Date("2026-07-19T12:06:59.999Z"),
        })
        const firstPublicationRows = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap((sql) =>
            sql<{ readonly state: string }>`
              SELECT state FROM publications WHERE id = ${firstPublication.id}
            `,
          ),
        )
        const secondReview = yield* store.claimNextJob({
          workerId: "reviewer-rereview-2",
          now: new Date("2026-07-19T12:08:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (secondReview === null) throw new Error("expected second review")
        yield* store.completeReviewJob({
          jobId: secondReview.id,
          workerId: "reviewer-rereview-2",
          completedAt: new Date("2026-07-19T12:08:59.999Z"),
          review: {
            verdict: "pass",
            summary: "The new review passes.",
            findings: [],
          },
          autoFix: false,
        })
        const secondPublication = yield* store.claimNextPublication({
          workerId: "publisher-rereview-2",
          now: new Date("2026-07-19T12:10:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return {
          disposition,
          firstPublicationState: firstPublicationRows[0]?.state,
          firstPublication,
          firstReview,
          secondPublication,
          secondReview,
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toBe("review")
    expect(result.firstPublicationState).toBe("superseded")
    expect(result.secondReview.id).not.toBe(result.firstReview.id)
    expect(result.firstPublication.operationKey).toBe("review:42:7:1")
    expect(result.secondPublication).toMatchObject({
      operationKey: "review:42:7:1:2",
      review: { verdict: "pass" },
    })
  })
})

describe("WorkflowStore.rescheduleJob", () => {
  test("releases a failed job until its durable retry time", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-retry",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const job = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (job === null) throw new Error("expected job")
        const disposition = yield* store.rescheduleJob({
          jobId: job.id,
          workerId: "worker-1",
          failedAt: new Date("2026-07-19T12:01:30.000Z"),
          runAt: new Date("2026-07-19T12:10:00.000Z"),
          error: "temporary failure",
          maxAttempts: 3,
        })
        const early = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:09:59.000Z"),
          leaseDurationMs: 60_000,
        })
        const retried = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:10:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, early, retried }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toBe("retry")
    expect(result.early).toBeNull()
    expect(Number(result.retried?.attempt)).toBe(2)
  })
})

describe("pull request eligibility", () => {
  test("cancels queued work when the pull request closes", async () => {
    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-open",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-closed",
            event: "pull_request",
            action: "closed",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "closed",
            pullRequest: { ...samplePullRequestEvent.pullRequest, state: "closed" },
          }),
        )
        return yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(claimed).toBeNull()
  })

  test("ignores an out-of-order event for an older GitHub update", async () => {
    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-new-head",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:02:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "b".repeat(40),
              updatedAt: "2026-07-19T12:02:00.000Z",
            },
          }),
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-old-head",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "c".repeat(40),
              updatedAt: "2026-07-19T12:01:00.000Z",
            },
          }),
        )
        return yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(String(claimed?.target.headSha)).toBe("b".repeat(40))
  })

  test("requeues a completed same-SHA review when the pull request is reopened", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const opened = {
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-19T12:00:00.000Z",
          },
        }
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-lifecycle-open",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          opened,
        )
        const first = yield* store.claimNextJob({
          workerId: "reviewer-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (first === null) throw new Error("expected first review")
        yield* store.completeReviewJob({
          jobId: first.id,
          workerId: "reviewer-1",
          completedAt: new Date("2026-07-19T12:01:30.000Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-lifecycle-close",
            event: "pull_request",
            action: "closed",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:02:01.000Z"),
          },
          {
            ...opened,
            action: "closed",
            pullRequest: {
              ...opened.pullRequest,
              state: "closed",
              updatedAt: "2026-07-19T12:02:00.000Z",
            },
          },
        )
        const reopened = yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-lifecycle-reopen",
            event: "pull_request",
            action: "reopened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:01.000Z"),
          },
          {
            ...opened,
            action: "reopened",
            pullRequest: {
              ...opened.pullRequest,
              updatedAt: "2026-07-19T12:03:00.000Z",
            },
          },
        )
        const second = yield* store.claimNextJob({
          workerId: "reviewer-2",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { first, reopened, second }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.reopened).toEqual({ status: "enqueued", generation: 1 })
    expect(result.second).toMatchObject({
      _tag: "ReviewWork",
      generation: 1,
      target: { headSha: "a".repeat(40) },
    })
    expect(result.second?.id).not.toBe(result.first.id)
  })

  test("requeues a superseded same-SHA review when a draft becomes ready", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const opened = {
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-19T12:00:00.000Z",
          },
        }
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-ready-open",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          opened,
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-ready-draft",
            event: "pull_request",
            action: "converted_to_draft",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:01.000Z"),
          },
          {
            ...opened,
            action: "converted_to_draft",
            pullRequest: {
              ...opened.pullRequest,
              draft: true,
              updatedAt: "2026-07-19T12:01:00.000Z",
            },
          },
        )
        const ready = yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-ready",
            event: "pull_request",
            action: "ready_for_review",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:02:01.000Z"),
          },
          {
            ...opened,
            action: "ready_for_review",
            pullRequest: {
              ...opened.pullRequest,
              updatedAt: "2026-07-19T12:02:00.000Z",
            },
          },
        )
        const job = yield* store.claimNextJob({
          workerId: "reviewer-ready",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { job, ready }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.ready).toEqual({ status: "enqueued", generation: 1 })
    expect(result.job).toMatchObject({ _tag: "ReviewWork", generation: 1 })
  })

  test("queues reconciliation for conflicting equal-timestamp snapshots", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const timestamp = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-equal-first",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          {
            ...samplePullRequestEvent,
            pullRequest: { ...samplePullRequestEvent.pullRequest, updatedAt: timestamp },
          },
        )
        const disposition = yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-equal-conflict",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:02.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt: timestamp,
            },
          }),
        )
        const job = yield* store.claimNextJob({
          workerId: "reviewer-equal",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, job }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toEqual({
      status: "reconciliation_enqueued",
      generation: 1,
    })
    expect(String(result.job?.target.headSha)).toBe("a".repeat(40))
  })

  test("queues reconciliation for a missing-timestamp head change", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-missing-first",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const disposition = yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-missing-head",
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
              headSha: "f".repeat(40),
            },
          }),
        )
        const job = yield* store.claimNextJob({
          workerId: "reviewer-missing",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, job }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toEqual({
      status: "reconciliation_enqueued",
      generation: 1,
    })
    expect(String(result.job?.target.headSha)).toBe("a".repeat(40))
  })

  test("does not erase a known ordering watermark with a missing timestamp", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-watermark-first",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:02:01.000Z"),
          },
          {
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: "2026-07-19T12:02:00.000Z",
            },
          },
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-watermark-missing",
            event: "pull_request",
            action: "labeled",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          { ...samplePullRequestEvent, action: "labeled" },
        )
        const stale = yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-watermark-stale",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:04:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "9".repeat(40),
              updatedAt: "2026-07-19T12:01:00.000Z",
            },
          }),
        )
        const job = yield* store.claimNextJob({
          workerId: "reviewer-watermark",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { job, stale }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.stale).toEqual({ status: "ignored", generation: 1 })
    expect(String(result.job?.target.headSha)).toBe("a".repeat(40))
  })

  test("does not reopen a terminal PR from an ambiguous event", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-terminal-open",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-terminal-close",
            event: "pull_request",
            action: "closed",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:00.000Z"),
          },
          {
            ...samplePullRequestEvent,
            action: "closed",
            pullRequest: { ...samplePullRequestEvent.pullRequest, state: "closed" },
          },
        )
        const disposition = yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-terminal-regression",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:02:00.000Z"),
          },
          { ...samplePullRequestEvent, action: "synchronize" },
        )
        const job = yield* store.claimNextJob({
          workerId: "reviewer-terminal",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, job }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.disposition).toEqual({
      status: "reconciliation_enqueued",
      generation: 1,
    })
    expect(result.job).toBeNull()
  })
})
