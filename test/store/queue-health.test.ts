import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { WorkflowStore } from "../../src/store/contracts"
import {
  makeStoreLayer,
  sampleBaseSha,
  sampleCommandEvent,
  sampleHeadSha,
  samplePullRequestEvent,
} from "./harness"

const TestLayer = makeStoreLayer()
const at = (minute: string) => new Date(`2026-07-19T12:${minute}:00.000Z`)

const delivery = (deliveryId: string) => ({
  deliveryId,
  event: "pull_request",
  action: "opened",
  payload: "{}",
  receivedAt: at("00"),
})

/** Ingest a pull request, claim the Review Work it queues, and spend its budget. */
const failedReviewJob = Effect.gen(function* () {
  const store = yield* WorkflowStore
  yield* store.ingestPullRequest(delivery("delivery-queue-health"), samplePullRequestEvent)
  const job = yield* store.claimNextJob({
    workerId: "worker-1",
    now: at("01"),
    leaseDurationMs: 600_000,
  })
  if (job === null) throw new Error("expected queued Review Work")
  const disposition = yield* store.rescheduleJob({
    jobId: job.id,
    workerId: "worker-1",
    failedAt: at("02"),
    runAt: at("03"),
    error: "GitHub was unreachable",
    maxAttempts: 1,
  })
  if (disposition !== "failed") throw new Error(`expected a failed job, got ${disposition}`)
  return job
})

const insertSessionReady = (jobId: number, sessionReferenceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO agent_executions (
        session_reference_id, job_id, attempt, lease_token, launch_intent_json,
        session_reference_json, state, created_at, updated_at
      ) VALUES (
        ${sessionReferenceId}, ${jobId}, 1, ${"lease-token-0123456789"}, '{}',
        '{}', 'session_ready', ${at("01").toISOString()}, ${at("01").toISOString()}
      )
    `
  })

describe("terminal failure summary", () => {
  test("counts each queue's terminally failed work and the sessions awaiting an operator", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        const job = yield* failedReviewJob
        yield* insertSessionReady(job.id, "session-awaiting-operator")
        yield* sql`
          UPDATE agent_executions
          SET cleanup_disposition = 'operator_required'
          WHERE session_reference_id = 'session-awaiting-operator'
        `
        yield* sql`
          INSERT INTO reconciliations (
            installation_id, repository_id, repository_full_name, pull_request_number,
            state, attempts, max_attempts, run_at, last_error, created_at, updated_at
          ) VALUES (
            91, 42, 'example-owner/example', 7, 'data_error', 5, 5, ${at("00").toISOString()},
            'could not decode', ${at("00").toISOString()}, ${at("04").toISOString()}
          )
        `
        return yield* store.summarizeTerminalFailures()
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(summary).toEqual({
      queues: [
        {
          queue: "jobs",
          failed: 1,
          quarantined: 0,
          oldestFailureAt: at("02").toISOString(),
        },
        { queue: "publications", failed: 0, quarantined: 0, oldestFailureAt: null },
        { queue: "commands", failed: 0, quarantined: 0, oldestFailureAt: null },
        {
          queue: "reconciliations",
          failed: 0,
          quarantined: 1,
          oldestFailureAt: at("04").toISOString(),
        },
      ],
      agentSessionsAwaitingOperator: 1,
    })
  })
})

describe("failed work listing and retry", () => {
  test("puts an eligible failed job back where a worker claims it again", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const job = yield* failedReviewJob
        const listed = yield* store.listFailedWork({ queue: "jobs", limit: 10 })
        const beforeRetry = yield* store.claimNextJob({
          workerId: "worker-2",
          now: at("05"),
          leaseDurationMs: 60_000,
        })
        const disposition = yield* store.requeueFailedWork({
          queue: "jobs",
          id: job.id,
          now: at("06"),
        })
        const afterRetry = yield* store.claimNextJob({
          workerId: "worker-2",
          now: at("06"),
          leaseDurationMs: 60_000,
        })
        return { listed, beforeRetry, disposition, afterRetry }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.listed).toEqual([
      {
        id: expect.any(Number),
        state: "failed",
        attempts: 1,
        maxAttempts: 1,
        repositoryFullName: "example-owner/example",
        pullRequestNumber: 7,
        lastError: "GitHub was unreachable",
        failedAt: at("02").toISOString(),
        eligibility: "eligible",
      },
    ])
    expect(result.beforeRetry).toBeNull()
    expect(result.disposition).toBe("requeued")
    expect(result.afterRetry?._tag).toBe("ReviewWork")
    expect(Number(result.afterRetry?.attempt)).toBe(1)
  })

  test("keeps a quarantined record quarantined", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(delivery("delivery-quarantine"), samplePullRequestEvent)
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE jobs SET base_sha = 'not-a-sha'`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        // Claiming is what quarantines the row it cannot decode.
        yield* store.claimNextJob({
          workerId: "worker-1",
          now: at("01"),
          leaseDurationMs: 60_000,
        })
        const listed = yield* store.listFailedWork({ queue: "jobs", limit: 10 })
        const first = listed[0]
        if (first === undefined) throw new Error("expected a quarantined job")
        const disposition = yield* store.requeueFailedWork({
          queue: "jobs",
          id: first.id,
          now: at("06"),
        })
        const states = yield* sql<{ readonly state: string }>`SELECT state FROM jobs`
        return { listed, disposition, states }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.listed[0]).toMatchObject({ state: "data_error", eligibility: "quarantined" })
    expect(result.disposition).toBe("quarantined")
    expect(result.states).toEqual([{ state: "data_error" }])
  })

  test("refuses work a newer head superseded", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        const job = yield* failedReviewJob
        yield* sql`
          UPDATE pull_requests
          SET head_sha = ${"b".repeat(40)}, generation = 2
          WHERE repository_id = 42 AND pull_request_number = 7
        `
        const listed = yield* store.listFailedWork({ queue: "jobs", limit: 10 })
        const disposition = yield* store.requeueFailedWork({
          queue: "jobs",
          id: job.id,
          now: at("06"),
        })
        return { listed, disposition }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.listed[0]).toMatchObject({ eligibility: "superseded" })
    expect(result.disposition).toBe("superseded")
  })

  test("refuses a job whose agent session is still live", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const job = yield* failedReviewJob
        yield* insertSessionReady(job.id, "session-still-live")
        const listed = yield* store.listFailedWork({ queue: "jobs", limit: 10 })
        const disposition = yield* store.requeueFailedWork({
          queue: "jobs",
          id: job.id,
          now: at("06"),
        })
        return { listed, disposition }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.listed[0]).toMatchObject({ eligibility: "agent_session_pending" })
    expect(result.disposition).toBe("agent_session_pending")
  })

  test("reports a record that is absent or has not failed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(delivery("delivery-not-failed"), samplePullRequestEvent)
        const absent = yield* store.requeueFailedWork({ queue: "jobs", id: 4_242, now: at("06") })
        const ready = yield* store.requeueFailedWork({ queue: "jobs", id: 1, now: at("06") })
        return { absent, ready }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result).toEqual({ absent: "not_found", ready: "not_failed" })
  })

  test("retries a failed command, which no supersession can reach", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        yield* store.ingestPullRequest(delivery("delivery-command-pr"), samplePullRequestEvent)
        yield* store.ingestCommand(
          { ...delivery("delivery-command"), event: "issue_comment", action: "created" },
          sampleCommandEvent("review", 5001),
        )
        const command = yield* store.claimNextCommand({
          workerId: "commands-1",
          now: at("01"),
          leaseDurationMs: 600_000,
        })
        if (command === null) throw new Error("expected a queued command")
        yield* store.rescheduleCommand({
          commandId: command.id,
          workerId: "commands-1",
          failedAt: at("02"),
          runAt: at("03"),
          error: "store was busy",
          maxAttempts: 1,
        })
        const listed = yield* store.listFailedWork({ queue: "commands", limit: 10 })
        const disposition = yield* store.requeueFailedWork({
          queue: "commands",
          id: command.id,
          now: at("06"),
        })
        const reclaimed = yield* store.claimNextCommand({
          workerId: "commands-1",
          now: at("06"),
          leaseDurationMs: 60_000,
        })
        return { listed, disposition, reclaimed }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.listed[0]).toMatchObject({ state: "failed", eligibility: "eligible" })
    expect(result.disposition).toBe("requeued")
    expect(result.reclaimed?.command).toBe("review")
  })

  test("refuses a publication the current pull request no longer matches", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        yield* store.ingestPullRequest(delivery("delivery-publication"), samplePullRequestEvent)
        yield* sql`
          INSERT INTO publications (
            id, operation_key, installation_id, repository_id, repository_full_name,
            pull_request_number, base_ref, base_sha, expected_head_sha, head_ref,
            head_repository_full_name, generation, review_request_number, review_json,
            state, attempts, max_attempts, run_at, last_error, created_at, updated_at
          ) VALUES (
            1, 'review:42:7:1:1', 91, 42, 'example-owner/example', 7, 'main',
            ${sampleBaseSha}, ${sampleHeadSha}, 'opencode/example-job',
            'example-owner/example', 1, 1,
            ${JSON.stringify({ verdict: "pass", summary: "Looks fine.", findings: [] })},
            'failed', 5, 5, ${at("00").toISOString()}, 'GitHub rejected the comment',
            ${at("00").toISOString()}, ${at("02").toISOString()}
          )
        `
        yield* sql`
          UPDATE pull_requests SET state = 'closed'
          WHERE repository_id = 42 AND pull_request_number = 7
        `
        const listed = yield* store.listFailedWork({ queue: "publications", limit: 10 })
        const disposition = yield* store.requeueFailedWork({
          queue: "publications",
          id: 1,
          now: at("06"),
        })
        return { listed, disposition }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.listed[0]).toMatchObject({ eligibility: "superseded" })
    expect(result.disposition).toBe("superseded")
  })
})
