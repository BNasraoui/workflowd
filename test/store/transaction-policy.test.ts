import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ReviewResult } from "../../src/domain/review-result"
import { WorkflowStore } from "../../src/store/contracts"
import {
  changesRequestedReview,
  makeStoreLayer,
  sampleCommandEvent,
  samplePullRequestEvent,
} from "./harness"

const runFixPath = (
  mode: "automatic" | "manual",
  event: typeof samplePullRequestEvent,
  review: ReviewResult,
  fixWorkEnabled = true,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: `policy-${mode}-pr`,
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-19T12:00:00.000Z"),
        },
        event,
      )
      const reviewWork = yield* store.claimNextJob({
        workerId: `policy-${mode}-reviewer`,
        now: new Date("2026-07-19T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (reviewWork === null) throw new Error("expected review work")
      yield* store.completeReviewJob({
        jobId: reviewWork.id,
        workerId: `policy-${mode}-reviewer`,
        completedAt: new Date("2026-07-19T12:01:59.999Z"),
        review,
        autoFix: mode === "automatic" && fixWorkEnabled,
      })

      let disposition:
        | "automatic"
        | "review"
        | "fix"
        | "status"
        | "noop"
        | "disabled"
        | "denied"
        | "stale" = "automatic"
      if (mode === "manual") {
        yield* store.ingestCommand(
          {
            deliveryId: "policy-manual-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:03:00.000Z"),
          },
          sampleCommandEvent("fix", 7001),
        )
        const command = yield* store.claimNextCommand({
          workerId: "policy-command-worker",
          now: new Date("2026-07-19T12:04:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected command")
        disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "policy-command-worker",
          authorized: true,
          fixWorkEnabled,
          completedAt: new Date("2026-07-19T12:04:59.999Z"),
        })
      }
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM jobs WHERE kind = 'fix'
      `
      return { count: rows[0]?.count ?? 0, disposition }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

describe("transaction policy integration", () => {
  test("automatic and manual fix requests cannot diverge", async () => {
    const passingReview: ReviewResult = {
      verdict: "pass",
      summary: "No actionable findings.",
      findings: [],
    }
    for (const [event, review, expectedCount, manualDisposition] of [
      [samplePullRequestEvent, changesRequestedReview, 1, "fix"],
      [samplePullRequestEvent, passingReview, 0, "noop"],
      [
        {
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            headRepositoryFullName: "contributor/example",
          },
        },
        changesRequestedReview,
        0,
        "denied",
      ],
    ] as const) {
      const [automatic, manual] = await Promise.all([
        runFixPath("automatic", event, review),
        runFixPath("manual", event, review),
      ])
      expect(automatic.count).toBe(expectedCount)
      expect(manual.count).toBe(expectedCount)
      expect(manual.disposition).toBe(manualDisposition)
    }
  })

  test("finishes a disabled manual fix command without durable Fix Work", async () => {
    const result = await runFixPath(
      "manual",
      samplePullRequestEvent,
      changesRequestedReview,
      false,
    )

    expect(result).toEqual({ count: 0, disposition: "disabled" })
  })
})
