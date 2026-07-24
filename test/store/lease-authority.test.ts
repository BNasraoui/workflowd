import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { FixResult } from "../../src/domain/fix-result"
import { WorkflowStore } from "../../src/store/contracts"
import {
  changesRequestedReview,
  decodePullRequestEvent,
  makeStoreLayer,
  sampleCommandEvent,
  samplePullRequestEvent,
} from "./harness"

const delivery = (deliveryId: string, action: string, receivedAt: string) => ({
  deliveryId,
  event: "pull_request",
  action,
  payload: "{}",
  receivedAt: new Date(receivedAt),
})

describe("expired lease authority", () => {
  test("persists a superseded disposition for stale evidence while the lease is current", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          delivery("stale-evidence-pr", "opened", "2026-07-20T12:00:00.000Z"),
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "stale-evidence-reviewer",
          now: new Date("2026-07-20T13:00:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        const disposition = yield* store.supersedeJob({
          jobId: review.id,
          workerId: "stale-evidence-reviewer",
          supersededAt: new Date("2026-07-20T13:00:01.000Z"),
          reason: "Pull request target changed during evidence collection.",
        })
        const rows = yield* sql<{
          readonly state: string
          readonly lease_owner: string | null
          readonly last_error: string | null
        }>`SELECT state, lease_owner, last_error FROM jobs WHERE id = ${review.id}`
        return { disposition, row: rows[0] }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result).toEqual({
      disposition: "superseded",
      row: {
        state: "superseded",
        lease_owner: null,
        last_error: "Pull request target changed during evidence collection.",
      },
    })
  })

  test("rejects review cancellation and completion at exact expiry", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          delivery("expired-review-pr", "opened", "2026-07-20T12:00:00.000Z"),
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "expired-reviewer",
          now: new Date("2026-07-20T13:00:00.000Z"),
          leaseDurationMs: 1_000,
        })
        if (review === null) throw new Error("expected review")
        const now = new Date("2026-07-20T13:00:01.000Z")
        const shouldCancel = yield* store.shouldCancelJob(review.id, "expired-reviewer", now)
        const completed = yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "expired-reviewer",
          completedAt: now,
          review: changesRequestedReview,
          autoFix: true,
        })
        const publications = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM publications
        `
        return {
          completed,
          publicationCount: publications[0]?.count,
          shouldCancel,
        }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result).toEqual({
      completed: "stale",
      publicationCount: 0,
      shouldCancel: true,
    })
  })

  test("rejects fix checkpoint and completion at exact expiry", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          delivery("expired-fix-pr", "opened", "2026-07-20T12:00:00.000Z"),
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "expired-fix-reviewer",
          now: new Date("2026-07-20T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "expired-fix-reviewer",
          completedAt: new Date("2026-07-20T12:01:01.000Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "expired-fix-publisher",
          now: new Date("2026-07-20T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "expired-fix-publisher",
          completedAt: new Date("2026-07-20T12:02:01.000Z"),
          outcome: "published",
        })
        const fix = yield* store.claimNextJob({
          workerId: "expired-fixer",
          now: new Date("2026-07-20T13:00:00.000Z"),
          leaseDurationMs: 1_000,
        })
        if (fix === null || fix._tag !== "FixWork") throw new Error("expected fix")
        const now = new Date("2026-07-20T13:00:01.000Z")
        const recorded = yield* store.recordFixResult({
          jobId: fix.id,
          workerId: "expired-fixer",
          recordedAt: now,
          result: Schema.decodeUnknownSync(FixResult)({
            _tag: "NoChanges",
            summary: "No changes.",
          }),
        })
        const completed = yield* store.completeFixJob({
          jobId: fix.id,
          workerId: "expired-fixer",
          completedAt: now,
        })
        return { completed, recorded }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result).toEqual({ completed: "stale", recorded: "stale" })
  })

  test("rejects publication guard and completion at exact expiry", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(
          delivery("expired-publication-pr", "opened", "2026-07-20T12:00:00.000Z"),
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "expired-publication-reviewer",
          now: new Date("2026-07-20T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "expired-publication-reviewer",
          completedAt: new Date("2026-07-20T12:01:01.000Z"),
          review: changesRequestedReview,
          autoFix: false,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "expired-publisher",
          now: new Date("2026-07-20T13:00:00.000Z"),
          leaseDurationMs: 1_000,
        })
        if (publication === null) throw new Error("expected publication")
        const now = new Date("2026-07-20T13:00:01.000Z")
        const current = yield* store.isPublicationCurrent(publication.id, "expired-publisher", now)
        const completed = yield* store.completePublication({
          publicationId: publication.id,
          workerId: "expired-publisher",
          completedAt: now,
          outcome: "published",
        })
        const rows = yield* sql<{
          readonly lease_owner: string | null
          readonly state: string
        }>`SELECT state, lease_owner FROM publications WHERE id = ${publication.id}`
        return { completed, current, row: rows[0] }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result).toEqual({
      completed: "stale",
      current: false,
      row: { state: "leased", lease_owner: "expired-publisher" },
    })
  })

  test("rejects command completion and reconciliation apply at exact expiry", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const updatedAt = "2026-07-20T12:00:00.000Z"
        yield* store.ingestPullRequest(
          delivery("expired-control-pr", "opened", updatedAt),
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: { ...samplePullRequestEvent.pullRequest, updatedAt },
          }),
        )
        yield* store.ingestPullRequest(
          delivery("expired-control-ambiguous", "synchronize", "2026-07-20T12:00:01.000Z"),
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt,
            },
          }),
        )
        const reconciliation = yield* store.claimNextReconciliation({
          workerId: "expired-reconciler",
          now: new Date("2026-07-20T13:00:00.000Z"),
          leaseDurationMs: 1_000,
        })
        if (reconciliation === null) throw new Error("expected reconciliation")
        const reconciliationResult = yield* store.applyReconciliationSnapshot({
          reconciliationId: reconciliation.id,
          workerId: "expired-reconciler",
          completedAt: new Date("2026-07-20T13:00:01.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: 91,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: "2026-07-20T12:00:02.000Z",
            },
          },
        })

        yield* store.ingestCommand(
          {
            deliveryId: "expired-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-20T12:00:02.000Z"),
          },
          sampleCommandEvent("status", 991),
        )
        const command = yield* store.claimNextCommand({
          workerId: "expired-command-worker",
          now: new Date("2026-07-20T14:00:00.000Z"),
          leaseDurationMs: 1_000,
        })
        if (command === null) throw new Error("expected command")
        const commandResult = yield* store.executeCommand({
          commandId: command.id,
          workerId: "expired-command-worker",
          authorized: true,
          fixWorkEnabled: false,
          completedAt: new Date("2026-07-20T14:00:01.000Z"),
        })
        return { commandResult, reconciliationResult }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result).toEqual({
      commandResult: "stale",
      reconciliationResult: "stale",
    })
  })
})
