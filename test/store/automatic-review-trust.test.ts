import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { WorkflowStore } from "../../src/store/contracts"
import { runCommandIteration } from "../../src/worker"
import {
  decodePullRequestEvent,
  runWithStore,
  sampleCommandEvent,
  samplePullRequestEvent,
} from "./harness"

const now = new Date("2026-10-12T10:00:00Z")
const delivery = (id: string) => ({
  deliveryId: id,
  event: "pull_request",
  action: "opened",
  payload: "{}",
  receivedAt: now,
})
const fork = (association?: string) =>
  decodePullRequestEvent({
    ...samplePullRequestEvent,
    pullRequest: {
      ...samplePullRequestEvent.pullRequest,
      author: "outside-user",
      headRepositoryFullName: "outside/example",
      ...(association === undefined ? {} : { authorAssociation: association }),
    },
  })

test.each([undefined, "NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"])(
  "records and skips an untrusted fork (%s)",
  async (association) => {
    await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const result = yield* store.ingestPullRequest(
          delivery(`skip-${association}`),
          fork(association),
        )
        expect(result).toEqual({
          status: "skipped",
          generation: 1,
          reason: "automatic-review-untrusted-fork",
        })
        expect(
          yield* store.claimNextJob({ workerId: "review", now, leaseDurationMs: 60000 }),
        ).toBeNull()
        const sql = yield* SqlClient.SqlClient
        const rows =
          yield* sql`SELECT author_association, automatic_review_skip_reason FROM pull_requests`
        expect(rows).toEqual([
          {
            author_association: association ?? null,
            automatic_review_skip_reason: "automatic-review-untrusted-fork",
          },
        ])
      }),
    )
  },
)

test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
  "reviews a trusted fork author (%s)",
  async (association) => {
    await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        expect(yield* store.ingestPullRequest(delivery(association), fork(association))).toEqual({
          status: "enqueued",
          generation: 1,
        })
      }),
    )
  },
)

test("reviews a same-repository head even for an outsider association", async () => {
  await runWithStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const event = fork("NONE")
      expect(
        yield* store.ingestPullRequest(delivery("same-repo"), {
          ...event,
          pullRequest: { ...event.pullRequest, headRepositoryFullName: "EXAMPLE-OWNER/example" },
        }),
      ).toEqual({ status: "enqueued", generation: 1 })
    }),
  )
})

test.each(["example-owner", "outsider"])(
  "manual review of a skipped fork respects commenter allowlist (%s)",
  async (commenter) => {
    await runWithStore(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(delivery("fork"), fork("NONE"))
        yield* store.ingestCommand(
          { ...delivery("command"), event: "issue_comment", action: "created" },
          { ...sampleCommandEvent("review", 100), commenter },
        )
        yield* runCommandIteration({
          workerId: "commands",
          leaseDurationMs: 60000,
          maxAttempts: 1,
          commandUsers: ["example-owner"],
          fixWorkEnabled: false,
          now: () => now,
        })
        const job = yield* store.claimNextJob({ workerId: "review", now, leaseDurationMs: 60000 })
        if (commenter === "example-owner") expect(job?._tag).toBe("ReviewWork")
        else expect(job).toBeNull()
      }),
    )
  },
)
