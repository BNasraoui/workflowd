import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import { decodePullRequestEvent, makeStoreLayer, samplePullRequestEvent } from "./harness"

const TestLayer = makeStoreLayer()

describe("durable pull request reconciliation", () => {
  test("deduplicates an ambiguous webhook and applies its authoritative generation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const timestamp = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "reconcile-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          {
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: timestamp,
            },
          },
        )
        const original = yield* store.claimNextJob({
          workerId: "reviewer-original",
          now: new Date("2026-07-19T12:00:02.000Z"),
          leaseDurationMs: 60_000,
        })
        if (original === null) throw new Error("expected original review")

        const ambiguous = decodePullRequestEvent({
          ...samplePullRequestEvent,
          action: "synchronize",
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            headSha: "e".repeat(40),
            updatedAt: timestamp,
          },
        })
        const first = yield* store.ingestPullRequest(
          {
            deliveryId: "reconcile-ambiguous-1",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:03.000Z"),
          },
          ambiguous,
        )
        const second = yield* store.ingestPullRequest(
          {
            deliveryId: "reconcile-ambiguous-2",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:04.000Z"),
          },
          ambiguous,
        )
        const reconciliation = yield* store.claimNextReconciliation({
          workerId: "reconciler-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reconciliation === null) throw new Error("expected reconciliation")

        const completed = yield* store.applyReconciliationSnapshot({
          reconciliationId: reconciliation.id,
          workerId: "reconciler-1",
          completedAt: new Date("2026-07-19T12:01:01.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: 91,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "b".repeat(40),
              updatedAt: "2026-07-19T12:00:05.000Z",
            },
          },
        })
        const duplicateClaim = yield* store.claimNextReconciliation({
          workerId: "reconciler-2",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        const review = yield* store.claimNextJob({
          workerId: "reviewer-authoritative",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return {
          completed,
          duplicateClaim,
          first,
          originalCancelled: yield* store.shouldCancelJob(
            original.id,
            "reviewer-original",
            new Date("2026-07-19T12:02:00.000Z"),
          ),
          reconciliation,
          review,
          second,
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.first).toEqual({
      status: "reconciliation_enqueued",
      generation: 1,
    })
    expect(result.second).toEqual({
      status: "reconciliation_enqueued",
      generation: 1,
    })
    expect(result.reconciliation).toMatchObject({
      installationId: 91,
      repositoryFullName: "example-owner/example",
      pullRequestNumber: 7,
      attempts: 1,
    })
    expect(result.completed).toBe("completed")
    expect(result.duplicateClaim).toBeNull()
    expect(result.originalCancelled).toBe(true)
    expect(result.review).toMatchObject({
      target: { headSha: "b".repeat(40) },
      generation: 2,
    })
  })

  test("rejects worker A's stale authoritative response after worker B reclaims and completes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        const observedAt = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "race-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: observedAt,
            },
          }),
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "race-ambiguous",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt: observedAt,
            },
          }),
        )

        const workerA = yield* store.claimNextReconciliation({
          workerId: "worker-a",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 1_000,
        })
        if (workerA === null) throw new Error("expected worker A claim")
        const workerB = yield* store.claimNextReconciliation({
          workerId: "worker-b",
          now: new Date("2026-07-19T12:01:02.000Z"),
          leaseDurationMs: 60_000,
        })
        if (workerB === null) throw new Error("expected worker B reclaim")

        const current = yield* store.applyReconciliationSnapshot({
          reconciliationId: workerB.id,
          workerId: "worker-b",
          completedAt: new Date("2026-07-19T12:01:03.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: 91,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "b".repeat(40),
              updatedAt: "2026-07-19T12:00:02.000Z",
            },
          },
        })
        const currentReview = yield* store.claimNextJob({
          workerId: "reviewer-b",
          now: new Date("2026-07-19T12:01:03.500Z"),
          leaseDurationMs: 60_000,
        })
        if (currentReview === null) throw new Error("expected worker B review")
        yield* store.completeReviewJob({
          jobId: currentReview.id,
          workerId: "reviewer-b",
          completedAt: new Date("2026-07-19T12:01:03.750Z"),
          review: {
            verdict: "pass",
            summary: "Worker B's current review.",
            findings: [],
          },
          autoFix: false,
        })
        const stale = yield* store.applyReconciliationSnapshot({
          reconciliationId: workerA.id,
          workerId: "worker-a",
          completedAt: new Date("2026-07-19T12:01:04.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: 91,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "c".repeat(40),
              updatedAt: "2026-07-19T12:00:01.000Z",
            },
          },
        })
        const tracked = yield* sql<{
          readonly generation: number
          readonly head_sha: string
        }>`
          SELECT generation, head_sha FROM pull_requests
          WHERE repository_id = 42 AND pull_request_number = 7
        `
        const jobs = yield* sql<{
          readonly generation: number
          readonly expected_head_sha: string
          readonly state: string
        }>`
          SELECT generation, expected_head_sha, state
          FROM jobs
          ORDER BY generation
        `
        const publications = yield* sql<{
          readonly generation: number
          readonly state: string
        }>`
          SELECT generation, state FROM publications ORDER BY generation
        `
        return { current, jobs, publications, stale, tracked: tracked[0] }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.current).toBe("completed")
    expect(result.stale).toBe("stale")
    expect(result.tracked).toEqual({
      generation: 2,
      head_sha: "b".repeat(40),
    })
    expect(result.jobs).toEqual([
      {
        generation: 1,
        expected_head_sha: "a".repeat(40),
        state: "superseded",
      },
      {
        generation: 2,
        expected_head_sha: "b".repeat(40),
        state: "succeeded",
      },
    ])
    expect(result.publications).toEqual([{ generation: 2, state: "ready" }])
  })

  test("rejects a fetched reconciliation after a newer webhook is accepted", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        const observedAt = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "webhook-race-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date(observedAt),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: observedAt,
            },
          }),
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "webhook-race-ambiguous",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt: observedAt,
            },
          }),
        )
        const reconciliation = yield* store.claimNextReconciliation({
          workerId: "webhook-race-reconciler",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reconciliation === null) throw new Error("expected reconciliation")

        const webhook = yield* store.ingestPullRequest(
          {
            deliveryId: "webhook-race-newer",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "b".repeat(40),
              updatedAt: "2026-07-19T12:00:02.000Z",
            },
          }),
        )
        const stale = yield* store.applyReconciliationSnapshot({
          reconciliationId: reconciliation.id,
          workerId: "webhook-race-reconciler",
          completedAt: new Date("2026-07-19T12:01:02.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: 91,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "c".repeat(40),
              updatedAt: "2026-07-19T12:00:01.000Z",
            },
          },
        })
        const tracked = yield* sql<{
          readonly generation: number
          readonly head_sha: string
        }>`SELECT generation, head_sha FROM pull_requests`
        const jobs = yield* sql<{
          readonly generation: number
          readonly expected_head_sha: string
          readonly state: string
        }>`SELECT generation, expected_head_sha, state FROM jobs ORDER BY id`
        const publications = yield* sql`SELECT * FROM publications`
        const reconciliationRows = yield* sql<{
          readonly lease_owner: string | null
          readonly lease_until: string | null
          readonly state: string
        }>`SELECT state, lease_owner, lease_until FROM reconciliations`
        return {
          jobs,
          publications,
          reconciliation: reconciliationRows[0],
          stale,
          tracked: tracked[0],
          webhook,
        }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.webhook).toEqual({ status: "enqueued", generation: 2 })
    expect(result.stale).toBe("stale")
    expect(result.tracked).toEqual({
      generation: 2,
      head_sha: "b".repeat(40),
    })
    expect(result.jobs).toEqual([
      {
        generation: 1,
        expected_head_sha: "a".repeat(40),
        state: "superseded",
      },
      {
        generation: 2,
        expected_head_sha: "b".repeat(40),
        state: "ready",
      },
    ])
    expect(result.publications).toEqual([])
    expect(result.reconciliation).toEqual({
      state: "ready",
      lease_owner: null,
      lease_until: null,
    })
  })

  test("does not revoke reconciliation for an ignored older delivery", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const observedAt = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "ignored-race-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date(observedAt),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: observedAt,
            },
          }),
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "ignored-race-ambiguous",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt: observedAt,
            },
          }),
        )
        const reconciliation = yield* store.claimNextReconciliation({
          workerId: "ignored-race-reconciler",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reconciliation === null) throw new Error("expected reconciliation")
        const ignored = yield* store.ingestPullRequest(
          {
            deliveryId: "ignored-race-older",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:01:00.500Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "c".repeat(40),
              updatedAt: "2026-07-19T11:59:59.000Z",
            },
          }),
        )
        const completed = yield* store.applyReconciliationSnapshot({
          reconciliationId: reconciliation.id,
          workerId: "ignored-race-reconciler",
          completedAt: new Date("2026-07-19T12:01:01.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: 91,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: "2026-07-19T12:00:02.000Z",
            },
          },
        })
        return { completed, ignored }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.ignored).toEqual({ status: "ignored", generation: 1 })
    expect(result.completed).toBe("completed")
  })
})
