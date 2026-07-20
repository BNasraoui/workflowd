import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { FixResult } from "../../src/domain/fix-result"
import { WorkflowStore } from "../../src/store/contracts"
import { changesRequestedReview, makeStoreLayer, samplePullRequestEvent } from "./harness"

describe("durable fix state", () => {
  test("retains the validated FixResult across a durable retry", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "fix-state-pr",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "fix-state-reviewer",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) throw new Error("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "fix-state-reviewer",
          completedAt: new Date("2026-07-19T12:01:59.999Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication({
          workerId: "fix-state-publisher",
          now: new Date("2026-07-19T12:03:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (publication === null) throw new Error("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: "fix-state-publisher",
          completedAt: new Date("2026-07-19T12:03:59.999Z"),
          outcome: "published",
        })
        const fix = yield* store.claimNextJob({
          workerId: "fix-state-worker-1",
          now: new Date("2026-07-19T12:05:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (fix === null) throw new Error("expected fix")
        const recorded = yield* store.recordFixResult({
          jobId: fix.id,
          workerId: "fix-state-worker-1",
          recordedAt: new Date("2026-07-19T12:05:10.000Z"),
          result: Schema.decodeUnknownSync(FixResult)({
            _tag: "CommitPrepared",
            summary: "Committed the verified fix.",
            commitSha: "c".repeat(40),
          }),
        })
        yield* store.rescheduleJob({
          jobId: fix.id,
          workerId: "fix-state-worker-1",
          failedAt: new Date("2026-07-19T12:05:20.000Z"),
          runAt: new Date("2026-07-19T12:06:00.000Z"),
          error: "crashed after push",
          maxAttempts: 3,
        })
        const retried = yield* store.claimNextJob({
          workerId: "fix-state-worker-2",
          now: new Date("2026-07-19T12:06:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { recorded, retried }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.recorded).toBe("recorded")
    expect(result.retried).toMatchObject({
      _tag: "FixWork",
      checkpoint: {
        _tag: "CommitPrepared",
        commitSha: "c".repeat(40),
      },
    })
  })
})
