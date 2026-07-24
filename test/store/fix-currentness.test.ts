import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import { changesRequestedReview, makeStoreLayer, samplePullRequestEvent } from "./harness"

const currentAt = new Date("2026-07-20T13:00:30.000Z")

const checkCurrentness = (
  mutation?: string,
  now = currentAt,
  mutationTiming: "before-claim" | "after-claim" = "after-claim",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: `fix-currentness-${mutation ?? "current"}`,
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        samplePullRequestEvent,
      )
      const review = yield* store.claimNextJob({
        workerId: "fix-currentness-reviewer",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 120_000,
      })
      if (review === null) throw new Error("expected review")
      yield* store.completeReviewJob({
        jobId: review.id,
        workerId: "fix-currentness-reviewer",
        completedAt: new Date("2026-07-20T12:01:01.000Z"),
        review: changesRequestedReview,
        autoFix: true,
      })
      const publication = yield* store.claimNextPublication({
        workerId: "fix-currentness-publisher",
        now: new Date("2026-07-20T12:02:00.000Z"),
        leaseDurationMs: 120_000,
      })
      if (publication === null) throw new Error("expected publication")
      yield* store.completePublication({
        publicationId: publication.id,
        workerId: "fix-currentness-publisher",
        completedAt: new Date("2026-07-20T12:02:01.000Z"),
        outcome: "published",
      })
      if (mutation !== undefined && mutationTiming === "before-claim") yield* sql.unsafe(mutation)
      const fix = yield* store.claimNextJob({
        workerId: "fix-currentness-worker",
        now: new Date("2026-07-20T13:00:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (fix === null && mutationTiming === "before-claim") return false
      if (fix === null || fix._tag !== "FixWork") throw new Error("expected fix")
      if (mutation !== undefined && mutationTiming === "after-claim") yield* sql.unsafe(mutation)
      return yield* store.isJobCurrent(fix.id, "fix-currentness-worker", now)
    }).pipe(Effect.provide(makeStoreLayer())),
  )

describe("durable Fix Work currentness", () => {
  test("accepts the exact current leased Fix Work", async () => {
    expect(await checkCurrentness()).toBe(true)
  })

  test.each([
    [
      "same-target re-review",
      `INSERT INTO jobs (
        kind, installation_id, repository_id, repository_full_name,
        pull_request_number, author, base_ref, base_sha, expected_head_sha,
        head_ref, head_repository_full_name, generation, review_request_number,
        state, run_at, created_at, updated_at
      ) SELECT
        kind, installation_id, repository_id, repository_full_name,
        pull_request_number, author, base_ref, base_sha, expected_head_sha,
        head_ref, head_repository_full_name, generation, 2,
        'ready', run_at, created_at, updated_at
      FROM jobs WHERE kind = 'review'`,
    ],
    ["closed pull request", "UPDATE pull_requests SET state = 'closed'"],
    ["draft pull request", "UPDATE pull_requests SET draft = TRUE"],
    ["changed base ref", "UPDATE pull_requests SET base_ref = 'release'"],
    ["changed base SHA", `UPDATE pull_requests SET base_sha = '${"b".repeat(40)}'`],
    ["changed head ref", "UPDATE pull_requests SET head_ref = 'other'"],
    ["changed author", "UPDATE pull_requests SET author = 'untrusted-collaborator'"],
    [
      "changed head repository",
      "UPDATE pull_requests SET head_repository_full_name = 'other/repository'",
    ],
    ["changed head SHA", `UPDATE pull_requests SET head_sha = '${"c".repeat(40)}'`],
  ])("rejects %s before push", async (_label, mutation) => {
    expect(await checkCurrentness(mutation)).toBe(false)
  })

  test("rejects the lease at exact expiry", async () => {
    expect(await checkCurrentness(undefined, new Date("2026-07-20T13:01:00.000Z"))).toBe(false)
  })

  test("does not claim queued Fix Work after the persisted author changes", async () => {
    expect(
      await checkCurrentness(
        "UPDATE pull_requests SET author = 'untrusted-collaborator'",
        currentAt,
        "before-claim",
      ),
    ).toBe(false)
  })
})

test("uses the same exact-target lease currentness gate while collecting review evidence", async () => {
  const current = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      yield* store.ingestPullRequest(
        {
          deliveryId: "review-evidence-currentness",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        samplePullRequestEvent,
      )
      const review = yield* store.claimNextJob({
        workerId: "evidence-reviewer",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 120_000,
      })
      if (review === null || review._tag !== "ReviewWork") throw new Error("expected review")
      return yield* store.isJobCurrent(
        review.id,
        "evidence-reviewer",
        new Date("2026-07-20T12:01:30.000Z"),
      )
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(current).toBe(true)
})
