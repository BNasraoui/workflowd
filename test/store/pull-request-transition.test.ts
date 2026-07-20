import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import { decodePullRequestEvent, makeStoreLayer, samplePullRequestEvent } from "./harness"

describe("pull request transition storage", () => {
  test.each([
    ["base", { baseSha: "c".repeat(40) }],
    ["provenance", { headRepositoryFullName: "fork/example" }],
  ])("advances same-head Generation for a %s target change", async (_, change) => {
    const deliveryKey = String(Object.values(change)[0])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const initial = {
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T10:00:00.000Z",
          },
        }
        yield* store.ingestPullRequest(
          {
            deliveryId: `target-${deliveryKey}-1`,
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:00:00.000Z"),
          },
          initial,
        )
        const first = yield* store.claimNextJob({
          workerId: "reviewer-1",
          now: new Date("2026-07-20T10:00:01.000Z"),
          leaseDurationMs: 60_000,
        })
        if (first === null) throw new Error("expected first review")

        const disposition = yield* store.ingestPullRequest(
          {
            deliveryId: `target-${deliveryKey}-2`,
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:01:00.000Z"),
          },
          decodePullRequestEvent({
            ...initial,
            action: "synchronize",
            pullRequest: {
              ...initial.pullRequest,
              ...change,
              updatedAt: "2026-07-20T10:01:00.000Z",
            },
          }),
        )
        const second = yield* store.claimNextJob({
          workerId: "reviewer-2",
          now: new Date("2026-07-20T10:01:01.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, second }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.disposition).toEqual({ status: "enqueued", generation: 2 })
    expect(result.second).toMatchObject({ generation: 2, target: change })
  })

  test("advances Generation when an authoritative snapshot corrects the base", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(
          {
            deliveryId: "authoritative-base-1",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const first = yield* store.claimNextJob({
          workerId: "reviewer-1",
          now: new Date("2026-07-20T10:00:01.000Z"),
          leaseDurationMs: 60_000,
        })
        if (first === null) throw new Error("expected first review")

        yield* store.ingestPullRequest(
          {
            deliveryId: "authoritative-base-ambiguous",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:00:02.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              baseSha: "c".repeat(40),
            },
          }),
        )
        const reconciliation = yield* store.claimNextReconciliation({
          workerId: "reconciler-1",
          now: new Date("2026-07-20T10:00:03.000Z"),
          leaseDurationMs: 60_000,
        })
        if (reconciliation === null) throw new Error("expected reconciliation")

        const disposition = yield* store.applyReconciliationSnapshot({
          reconciliationId: reconciliation.id,
          workerId: "reconciler-1",
          completedAt: new Date("2026-07-20T10:01:00.000Z"),
          snapshot: {
            _tag: "AuthoritativePullRequestSnapshot",
            installationId: samplePullRequestEvent.installationId,
            repository: samplePullRequestEvent.repository,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              baseSha: "c".repeat(40),
            },
          },
        })
        const second = yield* store.claimNextJob({
          workerId: "reviewer-2",
          now: new Date("2026-07-20T10:01:01.000Z"),
          leaseDurationMs: 60_000,
        })
        return { disposition, second }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.disposition).toBe("completed")
    expect(String(result.second?.target.baseSha)).toBe("c".repeat(40))
  })

  test("queues edited target changes but ignores same-target edits", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const initial = decodePullRequestEvent({
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T10:00:00.000Z",
          },
        })
        yield* store.ingestPullRequest(
          {
            deliveryId: "edited-target-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:00:00.000Z"),
          },
          initial,
        )
        const first = yield* store.claimNextJob({
          workerId: "edited-target-reviewer-1",
          now: new Date("2026-07-20T10:00:01.000Z"),
          leaseDurationMs: 10 * 60_000,
        })
        if (first === null) throw new Error("expected first review")

        const sameTarget = yield* store.ingestPullRequest(
          {
            deliveryId: "edited-target-title",
            event: "pull_request",
            action: "edited",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:01:00.000Z"),
          },
          decodePullRequestEvent({
            ...initial,
            action: "edited",
            pullRequest: {
              ...initial.pullRequest,
              updatedAt: "2026-07-20T10:01:00.000Z",
            },
          }),
        )
        const duplicate = yield* store.claimNextJob({
          workerId: "edited-target-reviewer-duplicate",
          now: new Date("2026-07-20T10:01:01.000Z"),
          leaseDurationMs: 60_000,
        })
        const changedTarget = yield* store.ingestPullRequest(
          {
            deliveryId: "edited-target-base",
            event: "pull_request",
            action: "edited",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:02:00.000Z"),
          },
          decodePullRequestEvent({
            ...initial,
            action: "edited",
            pullRequest: {
              ...initial.pullRequest,
              baseRef: "release",
              updatedAt: "2026-07-20T10:02:00.000Z",
            },
          }),
        )
        const replacement = yield* store.claimNextJob({
          workerId: "edited-target-reviewer-2",
          now: new Date("2026-07-20T10:02:01.000Z"),
          leaseDurationMs: 60_000,
        })
        return { changedTarget, duplicate, replacement, sameTarget }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.sameTarget).toEqual({ status: "ignored", generation: 1 })
    expect(result.duplicate).toBeNull()
    expect(result.changedTarget).toEqual({ status: "enqueued", generation: 2 })
    expect(result.replacement).toMatchObject({
      generation: 2,
      target: { baseRef: "release" },
    })
  })

  test("ignores a same-target edit after a non-reviewable observation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const initial = decodePullRequestEvent({
          ...samplePullRequestEvent,
          action: "labeled",
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T10:00:00.000Z",
          },
        })
        const observed = yield* store.ingestPullRequest(
          {
            deliveryId: "same-target-no-review-initial",
            event: "pull_request",
            action: "labeled",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:00:00.000Z"),
          },
          initial,
        )
        const edit = yield* store.ingestPullRequest(
          {
            deliveryId: "same-target-no-review-edited",
            event: "pull_request",
            action: "edited",
            payload: "{}",
            receivedAt: new Date("2026-07-20T10:01:00.000Z"),
          },
          decodePullRequestEvent({
            ...initial,
            action: "edited",
            pullRequest: {
              ...initial.pullRequest,
              updatedAt: "2026-07-20T10:01:00.000Z",
            },
          }),
        )
        const review = yield* store.claimNextJob({
          workerId: "same-target-no-review-reviewer",
          now: new Date("2026-07-20T10:01:01.000Z"),
          leaseDurationMs: 60_000,
        })
        return { edit, observed, review }
      }).pipe(Effect.provide(makeStoreLayer())),
    )

    expect(result.observed).toEqual({ status: "ignored", generation: 1 })
    expect(result.edit).toEqual({ status: "ignored", generation: 1 })
    expect(result.review).toBeNull()
  })
})
