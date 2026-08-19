import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import {
  changesRequestedReview,
  makeStoreLayer,
  sampleCommandEvent,
  samplePullRequestEvent,
  sampleBaseSha,
  sampleHeadSha,
} from "./harness"

const at = (minute: string, second = "00") => new Date(`2026-07-19T12:${minute}:${second}.000Z`)
const stamp = at("00").toISOString()
const observedAt = at("20").toISOString()

const run = <A, E>(effect: Effect.Effect<A, E, WorkflowStore | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeStoreLayer())))

const durableWorkTables = ["jobs", "publications", "commands", "reconciliations"] as const
type DurableWorkTable = (typeof durableWorkTables)[number]

const declaredStates = (ddl: string) => {
  const clause = /state TEXT NOT NULL CHECK \(state IN \(([\s\S]*?)\)\)/.exec(ddl)
  if (clause === null) throw new Error("no Work State CHECK constraint")
  return (clause[1] ?? "")
    .split(",")
    .map((state) => state.trim().replaceAll("'", ""))
    .filter((state) => state !== "")
    .sort()
}

const reviewJson = JSON.stringify(changesRequestedReview)

const openPullRequest = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO pull_requests (
      repository_id, pull_request_number, installation_id, repository_full_name,
      repository_owner, repository_name, author, base_ref, base_sha, draft,
      head_ref, head_repository_full_name, head_sha, github_updated_at, state,
      generation, updated_at
    ) VALUES (
      42, 7, 91, 'example-owner/example', 'example-owner', 'example', 'opencode-agent',
      'main', ${sampleBaseSha}, FALSE, 'opencode/example-job',
      'example-owner/example', ${sampleHeadSha}, ${stamp}, 'open', 1, ${stamp}
    )
  `
})

const insertReviewJob = (id: number, reviewRequestNumber: number, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO jobs (
        id, kind, installation_id, repository_id, repository_full_name,
        pull_request_number, author, base_ref, base_sha, expected_head_sha,
        head_ref, head_repository_full_name, generation, review_request_number,
        state, attempts, max_attempts, run_at, lease_owner, lease_until,
        last_error, created_at, updated_at
      ) VALUES (
        ${id}, 'review', 91, 42, 'example-owner/example', 7, 'opencode-agent', 'main',
        ${sampleBaseSha}, ${sampleHeadSha}, 'opencode/example-job',
        'example-owner/example', 1, ${reviewRequestNumber}, ${state}, 0, 3, ${stamp},
        ${state === "leased" ? "holder" : null},
        ${state === "leased" ? at("59").toISOString() : null},
        ${["retry_scheduled", "failed", "data_error"].includes(state) ? "recorded" : null},
        ${stamp}, ${stamp}
      )
    `
  })

const insertPublication = (id: number, reviewRequestNumber: number, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO publications (
        id, operation_key, installation_id, repository_id, repository_full_name,
        pull_request_number, base_ref, base_sha, expected_head_sha, head_ref,
        head_repository_full_name, generation, review_request_number, review_json,
        state, attempts, max_attempts, run_at, lease_owner, lease_until,
        last_error, created_at, updated_at
      ) VALUES (
        ${id}, ${`review:42:7:1:${id}`}, 91, 42, 'example-owner/example', 7, 'main',
        ${sampleBaseSha}, ${sampleHeadSha}, 'opencode/example-job',
        'example-owner/example', 1, ${reviewRequestNumber}, ${reviewJson},
        ${state}, 0, 5, ${stamp},
        ${state === "leased" ? "holder" : null},
        ${state === "leased" ? at("59").toISOString() : null},
        ${["retry_scheduled", "failed", "data_error"].includes(state) ? "recorded" : null},
        ${stamp}, ${stamp}
      )
    `
  })

const workStates = (table: DurableWorkTable) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly id: number; readonly state: string }>`
      SELECT id, state FROM ${sql(table)} ORDER BY id
    `
    return rows.map((row) => `${row.id}:${row.state}`)
  })

describe("durable Work State vocabulary", () => {
  test("every durable work queue declares the same claimable and terminal states", async () => {
    const states = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly name: string; readonly sql: string }>`
          SELECT name, sql FROM sqlite_master WHERE type = 'table'
        `
        return Object.fromEntries(
          durableWorkTables.map((table) => {
            const ddl = rows.find((row) => row.name === table)?.sql
            if (ddl === undefined) throw new Error(`missing table ${table}`)
            return [table, declaredStates(ddl)]
          }),
        )
      }),
    )

    const shared = ["data_error", "failed", "leased", "ready", "retry_scheduled", "succeeded"]
    expect(states["jobs"]).toEqual([...shared, "superseded"].sort())
    expect(states["publications"]).toEqual([...shared, "superseded"].sort())
    expect(states["commands"]).toEqual(shared)
    expect(states["reconciliations"]).toEqual(shared)
  })
})

describe("durable Work State claim policy", () => {
  const claimable = ["ready", "retry_scheduled"] as const
  const unclaimable = ["succeeded", "failed", "data_error", "superseded"] as const

  test.each([...claimable])("a review job in %s is claimable", async (state) => {
    const claimed = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* openPullRequest
        yield* insertReviewJob(1, 1, state)
        return yield* store.claimNextJob({
          workerId: "worker",
          now: at("10"),
          leaseDurationMs: 60_000,
        })
      }),
    )

    expect(claimed?.id).toBe(1)
  })

  test.each([...unclaimable])("a review job in %s is never claimed", async (state) => {
    const claimed = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* openPullRequest
        yield* insertReviewJob(1, 1, state)
        return yield* store.claimNextJob({
          workerId: "worker",
          now: at("10"),
          leaseDurationMs: 60_000,
        })
      }),
    )

    expect(claimed).toBeNull()
  })

  test.each([...unclaimable])("a publication in %s is never claimed", async (state) => {
    const claimed = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* openPullRequest
        yield* insertReviewJob(1, 1, "succeeded")
        yield* insertPublication(1, 1, state)
        return yield* store.claimNextPublication({
          workerId: "worker",
          now: at("10"),
          leaseDurationMs: 60_000,
        })
      }),
    )

    expect(claimed).toBeNull()
  })

  test("a lease that has expired returns the work to its queue", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* openPullRequest
        yield* insertReviewJob(1, 1, "ready")
        const first = yield* store.claimNextJob({
          workerId: "worker-a",
          now: at("10"),
          leaseDurationMs: 60_000,
        })
        const held = yield* store.claimNextJob({
          workerId: "worker-b",
          now: at("10"),
          leaseDurationMs: 60_000,
        })
        const expired = yield* store.claimNextJob({
          workerId: "worker-b",
          now: at("11"),
          leaseDurationMs: 60_000,
        })
        return { expired: expired?.workerId, first: first?.workerId, held }
      }),
    )

    expect(result.first).toBe("worker-a")
    expect(result.held).toBeNull()
    expect(result.expired).toBe("worker-b")
  })
})

describe("Review Target currentness", () => {
  const publicationTargetColumns = {
    baseRef: ["base_ref", "release"],
    baseSha: ["base_sha", "b".repeat(40)],
    headRef: ["head_ref", "opencode/other-job"],
    headRepositoryFullName: ["head_repository_full_name", "fork-owner/example"],
    headSha: ["expected_head_sha", "c".repeat(40)],
  } as const

  test.each(Object.entries(publicationTargetColumns))(
    "a publication whose %s no longer matches the pull request is not current",
    async (_field, [column, replacement]) => {
      const result = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const store = yield* WorkflowStore
          yield* openPullRequest
          yield* insertReviewJob(1, 1, "succeeded")
          yield* insertPublication(1, 1, "ready")
          const before = yield* store.claimNextPublication({
            workerId: "publisher",
            now: at("10"),
            leaseDurationMs: 60_000,
          })
          const current = yield* store.isPublicationCurrent(1, "publisher", at("10", "30"))
          yield* sql`UPDATE publications SET ${sql(column)} = ${replacement} WHERE id = 1`
          const after = yield* store.isPublicationCurrent(1, "publisher", at("10", "30"))
          return { after, before: before?.id, current }
        }),
      )

      expect(result.before).toBe(1)
      expect(result.current).toBe(true)
      expect(result.after).toBe(false)
    },
  )

  test("a job is fenced by its expected head but not by its recorded base ref", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* WorkflowStore
        yield* openPullRequest
        yield* insertReviewJob(1, 1, "ready")
        yield* sql`UPDATE jobs SET base_ref = 'release' WHERE id = 1`
        const claimedWithOtherBaseRef = yield* store.claimNextJob({
          workerId: "worker",
          now: at("10"),
          leaseDurationMs: 60_000,
        })
        yield* sql`UPDATE jobs SET expected_head_sha = ${"c".repeat(40)} WHERE id = 1`
        const currentAfterHeadChange = yield* store.isJobCurrent(1, "worker", at("10", "30"))
        return { claimedWithOtherBaseRef: claimedWithOtherBaseRef?.id, currentAfterHeadChange }
      }),
    )

    expect(result.claimedWithOtherBaseRef).toBe(1)
    expect(result.currentAfterHeadChange).toBe(false)
  })
})

describe("Work State supersession scope", () => {
  const everyState = [
    "ready",
    "leased",
    "retry_scheduled",
    "succeeded",
    "failed",
    "superseded",
    "data_error",
  ] as const

  test("a newer Generation supersedes only unfinished work", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* openPullRequest
        for (const [index, state] of everyState.entries()) {
          yield* insertReviewJob(index + 1, index + 1, state)
          yield* insertPublication(index + 1, index + 1, state)
        }
        yield* store.ingestPullRequest(
          {
            deliveryId: "delivery-generation",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: at("20"),
          },
          {
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt: observedAt,
            },
          },
        )
        return {
          jobs: yield* workStates("jobs"),
          publications: yield* workStates("publications"),
        }
      }),
    )

    expect(result.jobs).toEqual([
      "1:superseded",
      "2:superseded",
      "3:superseded",
      "4:succeeded",
      "5:failed",
      "6:superseded",
      "7:data_error",
      "8:ready",
    ])
    expect(result.publications).toEqual([
      "1:superseded",
      "2:superseded",
      "3:superseded",
      "4:succeeded",
      "5:failed",
      "6:superseded",
      "7:data_error",
    ])
  })

  test("a newer Review Request also supersedes publications that already succeeded", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* openPullRequest
        yield* insertReviewJob(1, 1, "succeeded")
        yield* insertPublication(1, 1, "succeeded")
        yield* insertPublication(2, 1, "ready")
        yield* store.ingestCommand(
          {
            deliveryId: "delivery-review-command",
            event: "issue_comment",
            action: "created",
            payload: "{}",
            receivedAt: at("20"),
          },
          sampleCommandEvent("review", 3001),
        )
        const command = yield* store.claimNextCommand({
          workerId: "command-worker",
          now: at("21"),
          leaseDurationMs: 60_000,
        })
        if (command === null) throw new Error("expected a claimed command")
        const disposition = yield* store.executeCommand({
          commandId: command.id,
          workerId: "command-worker",
          authorized: true,
          fixWorkEnabled: true,
          completedAt: at("21", "30"),
        })
        return {
          disposition,
          jobs: yield* workStates("jobs"),
          publications: yield* workStates("publications"),
        }
      }),
    )

    expect(result.disposition).toBe("review")
    expect(result.publications).toEqual(["1:superseded", "2:superseded"])
    expect(result.jobs).toEqual(["1:succeeded", "2:ready"])
  })
})
