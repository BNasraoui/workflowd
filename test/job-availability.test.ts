import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { WorkflowStore } from "../src/store/contracts"
import { runJobIteration } from "../src/worker"
import { kernelLayer, stubAdapters } from "./helpers/runtime"
import { decodePullRequestEvent, samplePullRequestEvent } from "./store/harness"

const now = new Date("2026-07-19T12:00:00.000Z")
const options = {
  workerId: "gate-test",
  leaseDurationMs: 60000,
  maxAttempts: 3,
  timeoutMs: 1000,
  cancellationPollIntervalMs: 100,
  agentBranchPrefixes: ["opencode/"],
  trustedAgentUsers: ["opencode-agent"],
  fixWorkEnabled: false,
  now: () => now,
}

test("closed job gates still clean expired sessions and leave review attempts untouched", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "gated-review",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: now,
          },
          samplePullRequestEvent,
        )
        let cleanupCalls = 0
        const gatedStore = {
          ...store,
          claimExpiredAgentSession: () =>
            Effect.sync(() => {
              cleanupCalls++
              return null
            }),
        }
        for (let i = 0; i < 4; i++) {
          const result = yield* runJobIteration({
            ...options,
            availableJobKinds: Effect.succeed([]),
          }).pipe(Effect.provideService(WorkflowStore, gatedStore))
          expect(result).toBe("idle")
        }
        expect(cleanupCalls).toBe(4)
        const work = yield* store.claimNextJob({ ...options, now, kinds: ["review"] })
        expect(work).toMatchObject({ _tag: "ReviewWork", attempt: 1 })
      }),
    ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), stubAdapters()))),
  )
})

test("a closed fixer gate does not block review claims", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "review-only",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: now,
          },
          samplePullRequestEvent,
        )
        expect(yield* store.claimNextJob({ ...options, now, kinds: ["fix"] })).toBeNull()
        expect(yield* store.claimNextJob({ ...options, now, kinds: ["review"] })).toMatchObject({
          _tag: "ReviewWork",
          attempt: 1,
        })
      }),
    ).pipe(Effect.provide(kernelLayer(":memory:"))),
  )
})

test("paused fixer work does not hide reviews and disabled fixes are retired during an outage", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "fix-source",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: now,
          },
          samplePullRequestEvent,
        )
        const claim = { workerId: options.workerId, now, leaseDurationMs: 60000 }
        const review = yield* store.claimNextJob(claim)
        if (review === null) return yield* Effect.die("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: claim.workerId,
          completedAt: now,
          review: {
            verdict: "changes_requested",
            summary: "fix needed",
            findings: [{ severity: "high", title: "Bug", body: "Fix the bug" }],
          },
          autoFix: true,
        })
        const publication = yield* store.claimNextPublication(claim)
        if (publication === null) return yield* Effect.die("expected publication")
        yield* store.completePublication({
          publicationId: publication.id,
          workerId: claim.workerId,
          completedAt: now,
          outcome: "published",
        })
        yield* store.ingestPullRequest(
          {
            deliveryId: "parallel-review",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: now,
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: { ...samplePullRequestEvent.pullRequest, number: 8 },
          }),
        )
        expect(yield* store.claimNextJob({ ...claim, kinds: ["review"] })).toMatchObject({
          _tag: "ReviewWork",
          pullRequestNumber: 8,
          attempt: 1,
        })
        expect(yield* store.claimNextJob({ ...claim, kinds: ["review"] })).toBeNull()
        const result = yield* runJobIteration({
          ...options,
          availableJobKinds: Effect.succeed(["fix"] as const),
        })
        expect(result).toBe("disabled")
        expect(yield* store.claimNextJob({ ...claim, kinds: ["fix"] })).toBeNull()
      }),
    ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), stubAdapters()))),
  )
})
