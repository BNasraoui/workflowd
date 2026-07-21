import { expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { type AgentLaunchIntent, SessionReference } from "../../src/agent-harness"
import { WorkflowStore } from "../../src/store/contracts"
import { decodePullRequestEvent, makeStoreLayer, samplePullRequestEvent } from "./harness"

const makeExecution = (
  work: {
    readonly id: number
    readonly attempt: number
    readonly generation: number
    readonly repositoryId: number
    readonly pullRequestNumber: number
  },
  leaseToken: string,
  sessionReferenceId: string,
  requestedAt: string,
) => {
  const intent: AgentLaunchIntent<{ readonly subject: string }> = {
    sessionReferenceId,
    harness: { name: "opencode.pr-review", version: 1 },
    definitionHash: "a".repeat(64),
    agent: "pr-reviewer",
    model: "openai/gpt-5.6-sol",
    input: { subject: "example-owner/example#7" },
    scope: {
      _tag: "GenerationScope",
      workflowId: `pr:${work.repositoryId}:${work.pullRequestNumber}`,
      generation: work.generation,
    },
    operationId: `job:${work.id}`,
    operationRevision: 1,
    attempt: work.attempt,
    leaseToken,
    directory: "/tmp/review-worktree",
    timeoutMs: 10_000,
    retryPolicy: {
      maxAttempts: 3,
      structuredOutputRetryCount: 2,
      invalidOutput: "retry",
    },
    requestedAt,
  }
  const reference = Schema.decodeUnknownSync(SessionReference)({
    sessionReferenceId,
    serverId: "opencode-primary",
    endpointAlias: "private-opencode",
    directory: "/tmp/review-worktree",
    nativeSessionId: `ses_${work.attempt}`,
    scope: intent.scope,
    operationId: intent.operationId,
    operationRevision: intent.operationRevision,
    attempt: intent.attempt,
    leaseToken,
    createdAt: requestedAt,
    state: "created",
  })
  return { intent, reference }
}

test("persists agent checkpoints in order and completes output with downstream review work", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      const baseEvent = decodePullRequestEvent({
        ...samplePullRequestEvent,
        pullRequest: {
          ...samplePullRequestEvent.pullRequest,
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      })
      yield* store.ingestPullRequest(
        {
          deliveryId: "agent-execution-pr",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        baseEvent,
      )
      const work = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (work === null) throw new Error("expected review work")

      const leaseToken = "11111111-1111-4111-8111-111111111111"
      const sessionReferenceId = "22222222-2222-4222-8222-222222222222"
      const { intent, reference } = makeExecution(
        work,
        leaseToken,
        sessionReferenceId,
        "2026-07-20T12:01:01.000Z",
      )

      const beforeIntent = yield* store.recordAgentSessionReference({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference,
      })
      const launch = yield* store.recordAgentLaunchIntent({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent,
      })
      const afterLaunch = yield* sql`
        SELECT state, session_reference_json FROM agent_executions
        WHERE session_reference_id = ${sessionReferenceId}
      `
      const session = yield* store.recordAgentSessionReference({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference,
      })
      const reviewWithExcess = {
        verdict: "pass" as const,
        summary: "No findings.",
        findings: [],
        unexpected: "must not cross the durable boundary",
      }
      const completed = yield* store.completeAgentReviewJob({
        jobId: work.id,
        workerId: "agent-worker",
        sessionReferenceId,
        completedAt: new Date("2026-07-20T12:01:03.000Z"),
        review: reviewWithExcess,
        autoFix: false,
      })
      const durable = yield* sql`
        SELECT
          execution.state AS execution_state,
          execution.output_json,
          job.state AS job_state,
          publication.review_json,
          publication.session_reference_id
        FROM agent_executions AS execution
        JOIN jobs AS job ON job.id = execution.job_id
        JOIN publications AS publication
          ON publication.repository_id = job.repository_id
          AND publication.pull_request_number = job.pull_request_number
          AND publication.generation = job.generation
          AND publication.review_request_number = job.review_request_number
        WHERE execution.session_reference_id = ${sessionReferenceId}
      `
      return { beforeIntent, launch, afterLaunch, session, completed, durable }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.beforeIntent).toBe("stale")
  expect(result.launch).toBe("recorded")
  expect(result.afterLaunch).toEqual([{ state: "launch_intent", session_reference_json: null }])
  expect(result.session).toBe("recorded")
  expect(result.completed).toBe("completed")
  expect(result.durable).toEqual([
    {
      execution_state: "succeeded",
      output_json: JSON.stringify({ verdict: "pass", summary: "No findings.", findings: [] }),
      job_state: "succeeded",
      review_json: JSON.stringify({ verdict: "pass", summary: "No findings.", findings: [] }),
      session_reference_id: "22222222-2222-4222-8222-222222222222",
    },
  ])
})

test("persists a stale session reference for later cleanup", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      yield* store.ingestPullRequest(
        {
          deliveryId: "stale-agent-session",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        decodePullRequestEvent({
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T12:00:00.000Z",
          },
        }),
      )
      const work = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (work === null) throw new Error("expected review work")
      const execution = makeExecution(
        work,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: execution.intent,
      })

      const recorded = yield* store.recordAgentSessionReference({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:02:01.000Z"),
        reference: execution.reference,
      })
      const cleanup = yield* store.claimExpiredAgentSession({
        workerId: "cleanup-worker",
        now: new Date("2026-07-20T12:02:01.000Z"),
        leaseDurationMs: 60_000,
      })

      return { recorded, cleanup }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.recorded).toBe("stale")
  expect(result.cleanup?.nativeSessionId).toBe("ses_1")
})

test("keeps replacement work fenced after session cleanup reaches its attempt limit", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: "bounded-session-cleanup",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        decodePullRequestEvent(samplePullRequestEvent),
      )
      const work = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (work === null) throw new Error("expected review work")
      const execution = makeExecution(
        work,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: execution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference: execution.reference,
      })

      const cleanupResults: Array<string> = []
      for (const minute of [2, 3, 4]) {
        const failedAt = new Date(`2026-07-20T12:0${minute}:00.000Z`)
        const claimed = yield* store.claimExpiredAgentSession({
          workerId: "cleanup-worker",
          now: failedAt,
          leaseDurationMs: 1_000,
        })
        if (claimed === null) throw new Error("expected cleanup claim")
        cleanupResults.push(
          yield* store.recordAgentSessionCleanupFailure({
            sessionReferenceId: claimed.sessionReferenceId,
            workerId: "cleanup-worker",
            failedAt,
            error: "OpenCode unavailable",
          }),
        )
      }
      const replacement = yield* store.claimNextJob({
        workerId: "replacement-worker",
        now: new Date("2026-07-20T12:04:01.000Z"),
        leaseDurationMs: 60_000,
      })
      const rows = yield* sql`
        SELECT execution.state AS execution_state,
          execution.cleanup_disposition,
          execution.cleanup_last_error,
          job.state AS job_state
        FROM agent_executions AS execution
        JOIN jobs AS job ON job.id = execution.job_id
      `
      return { cleanupResults, replacement, rows }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.cleanupResults).toEqual(["pending", "pending", "operator_required"])
  expect(result.replacement).toBeNull()
  expect(result.rows).toEqual([
    {
      execution_state: "session_ready",
      cleanup_disposition: "operator_required",
      cleanup_last_error: "OpenCode unavailable",
      job_state: "leased",
    },
  ])
})

test("persists the maximum encoded built-in review output within the 4 MiB envelope", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: "large-agent-review",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        decodePullRequestEvent({
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T12:00:00.000Z",
          },
        }),
      )
      const work = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (work === null) throw new Error("expected review work")
      const execution = makeExecution(
        work,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: execution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference: execution.reference,
      })
      const review = {
        verdict: "changes_requested" as const,
        summary: "\u0001".repeat(4_000),
        findings: Array.from({ length: 50 }, () => ({
          severity: "critical" as const,
          title: "\u0001".repeat(200),
          body: "\u0001".repeat(10_000),
          path: "\u0001".repeat(1_024),
          line: Number.MAX_SAFE_INTEGER,
        })),
      }
      const completed = yield* store.completeAgentReviewJob({
        jobId: work.id,
        workerId: "agent-worker",
        sessionReferenceId: execution.reference.sessionReferenceId,
        completedAt: new Date("2026-07-20T12:01:03.000Z"),
        review,
        autoFix: false,
      })
      const rows = yield* sql<{ readonly output_length: number }>`
        SELECT length(output_json) AS output_length FROM agent_executions
      `
      return { completed, outputLength: rows[0]?.output_length }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.completed).toBe("completed")
  expect(result.outputLength).toBe(3_395_207)
})

test("rejects a durable launch intent larger than its 64 KiB envelope", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: "large-agent-launch-intent",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        decodePullRequestEvent({
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T12:00:00.000Z",
          },
        }),
      )
      const work = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (work === null) throw new Error("expected review work")
      const execution = makeExecution(
        work,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "2026-07-20T12:01:01.000Z",
      )
      const recorded = yield* Effect.either(
        store.recordAgentLaunchIntent({
          jobId: work.id,
          workerId: "agent-worker",
          recordedAt: new Date("2026-07-20T12:01:01.000Z"),
          intent: {
            ...execution.intent,
            input: { subject: "x".repeat(70_000) },
          },
        }),
      )
      const rows = yield* sql<{ readonly launch_intent_length: number }>`
        SELECT length(launch_intent_json) AS launch_intent_length FROM agent_executions
      `
      return { recorded, launchIntentLength: rows[0]?.launch_intent_length }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.recorded._tag).toBe("Left")
  expect(result.launchIntentLength).toBeUndefined()
})

test("quarantines malformed cleanup rows and continues to unrelated jobs", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: "malformed-cleanup-row",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        decodePullRequestEvent(samplePullRequestEvent),
      )
      const poisonedWork = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (poisonedWork === null) throw new Error("expected review work")
      const execution = makeExecution(
        poisonedWork,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: poisonedWork.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: execution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: poisonedWork.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference: execution.reference,
      })
      yield* sql`
        UPDATE agent_executions SET session_reference_json = '{}'
        WHERE session_reference_id = ${execution.reference.sessionReferenceId}
      `

      yield* store.ingestPullRequest(
        {
          deliveryId: "unrelated-valid-job",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:01:30.000Z"),
        },
        decodePullRequestEvent({
          ...samplePullRequestEvent,
          repository: {
            ...samplePullRequestEvent.repository,
            id: 43,
            fullName: "example-owner/unrelated",
            name: "unrelated",
          },
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            number: 8,
            headRepositoryFullName: "example-owner/unrelated",
          },
        }),
      )

      const cleanup = yield* store.claimExpiredAgentSession({
        workerId: "cleanup-worker",
        now: new Date("2026-07-20T12:02:01.000Z"),
        leaseDurationMs: 60_000,
      })
      const unrelated = yield* store.claimNextJob({
        workerId: "unrelated-worker",
        now: new Date("2026-07-20T12:02:01.000Z"),
        leaseDurationMs: 60_000,
      })
      const rows = yield* sql<{
        readonly cleanup_disposition: string | null
        readonly cleanup_last_error: string | null
        readonly state: string
      }>`
        SELECT cleanup_disposition, cleanup_last_error, state FROM agent_executions
      `
      return { cleanup, unrelated, rows }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.cleanup).toBeNull()
  expect(Number(result.unrelated?.pullRequestNumber)).toBe(8)
  expect(result.rows[0]).toMatchObject({
    cleanup_disposition: "data_error",
    state: "session_ready",
  })
  expect(result.rows[0]?.cleanup_last_error).toContain("session_reference_json")
})

test("restarts with a new session after either checkpoint and fences expired attempts", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      const baseEvent = decodePullRequestEvent({
        ...samplePullRequestEvent,
        pullRequest: {
          ...samplePullRequestEvent.pullRequest,
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      })
      yield* store.ingestPullRequest(
        {
          deliveryId: "agent-restart-pr",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        baseEvent,
      )

      const first = yield* store.claimNextJob({
        workerId: "agent-worker-1",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (first === null) throw new Error("expected first attempt")
      const firstExecution = makeExecution(
        first,
        "11111111-1111-4111-8111-111111111111",
        "21111111-1111-4111-8111-111111111111",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: first.id,
        workerId: "agent-worker-1",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: firstExecution.intent,
      })

      const second = yield* store.claimNextJob({
        workerId: "agent-worker-2",
        now: new Date("2026-07-20T12:02:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (second === null) throw new Error("expected second attempt")
      const orphanedReference = yield* store.recordAgentSessionReference({
        jobId: first.id,
        workerId: "agent-worker-1",
        recordedAt: new Date("2026-07-20T12:02:01.000Z"),
        reference: firstExecution.reference,
      })
      const secondExecution = makeExecution(
        second,
        "12222222-2222-4222-8222-222222222222",
        "22222222-2222-4222-8222-222222222222",
        "2026-07-20T12:02:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: second.id,
        workerId: "agent-worker-2",
        recordedAt: new Date("2026-07-20T12:02:01.000Z"),
        intent: secondExecution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: second.id,
        workerId: "agent-worker-2",
        recordedAt: new Date("2026-07-20T12:02:02.000Z"),
        reference: secondExecution.reference,
      })

      const blockedByExpiredSession = yield* store.claimNextJob({
        workerId: "agent-worker-3",
        now: new Date("2026-07-20T12:03:00.000Z"),
        leaseDurationMs: 60_000,
      })
      const firstExpiredSession = yield* store.claimExpiredAgentSession({
        workerId: "cleanup-worker",
        now: new Date("2026-07-20T12:03:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (firstExpiredSession === null) throw new Error("expected first expired session")
      yield* store.supersedeAgentSession(
        firstExpiredSession.sessionReferenceId,
        new Date("2026-07-20T12:03:00.000Z"),
      )
      const secondExpiredSession = yield* store.claimExpiredAgentSession({
        workerId: "cleanup-worker",
        now: new Date("2026-07-20T12:03:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (secondExpiredSession === null) throw new Error("expected second expired session")
      yield* store.supersedeAgentSession(
        secondExpiredSession.sessionReferenceId,
        new Date("2026-07-20T12:03:00.000Z"),
      )
      const third = yield* store.claimNextJob({
        workerId: "agent-worker-3",
        now: new Date("2026-07-20T12:03:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (third === null) throw new Error("expected third attempt")
      const late = yield* store.completeAgentReviewJob({
        jobId: second.id,
        workerId: "agent-worker-2",
        sessionReferenceId: secondExecution.reference.sessionReferenceId,
        completedAt: new Date("2026-07-20T12:03:01.000Z"),
        review: { verdict: "pass", summary: "Late output.", findings: [] },
        autoFix: false,
      })
      const thirdExecution = makeExecution(
        third,
        "13333333-3333-4333-8333-333333333333",
        "23333333-3333-4333-8333-333333333333",
        "2026-07-20T12:03:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: third.id,
        workerId: "agent-worker-3",
        recordedAt: new Date("2026-07-20T12:03:01.000Z"),
        intent: thirdExecution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: third.id,
        workerId: "agent-worker-3",
        recordedAt: new Date("2026-07-20T12:03:02.000Z"),
        reference: thirdExecution.reference,
      })
      const completed = yield* store.completeAgentReviewJob({
        jobId: third.id,
        workerId: "agent-worker-3",
        sessionReferenceId: thirdExecution.reference.sessionReferenceId,
        completedAt: new Date("2026-07-20T12:03:03.000Z"),
        review: { verdict: "pass", summary: "Current output.", findings: [] },
        autoFix: false,
      })
      const executions = yield* sql`
        SELECT attempt, state FROM agent_executions ORDER BY attempt
      `
      const publications = yield* sql`SELECT review_json FROM publications`
      return {
        blockedByExpiredSession,
        expiredSessions: [firstExpiredSession, secondExpiredSession],
        orphanedReference,
        late,
        completed,
        executions,
        publications,
      }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.orphanedReference).toBe("stale")
  expect(result.blockedByExpiredSession).toBeNull()
  expect(result.expiredSessions.map((session) => session.nativeSessionId).sort()).toEqual([
    "ses_1",
    "ses_2",
  ])
  expect(result.late).toBe("stale")
  expect(result.completed).toBe("completed")
  expect(result.executions).toEqual([
    { attempt: 1, state: "superseded" },
    { attempt: 2, state: "superseded" },
    { attempt: 3, state: "succeeded" },
  ])
  expect(result.publications).toEqual([
    {
      review_json: JSON.stringify({
        verdict: "pass",
        summary: "Current output.",
        findings: [],
      }),
    },
  ])
})

test("marks explicitly retried and terminally failed agent executions inactive", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      yield* store.ingestPullRequest(
        {
          deliveryId: "agent-failure-pr",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        decodePullRequestEvent({
          ...samplePullRequestEvent,
          pullRequest: {
            ...samplePullRequestEvent.pullRequest,
            updatedAt: "2026-07-20T12:00:00.000Z",
          },
        }),
      )

      const first = yield* store.claimNextJob({
        workerId: "agent-worker-1",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (first === null) throw new Error("expected first attempt")
      const firstExecution = makeExecution(
        first,
        "15555555-5555-4555-8555-555555555555",
        "25555555-5555-4555-8555-555555555555",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: first.id,
        workerId: "agent-worker-1",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: firstExecution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: first.id,
        workerId: "agent-worker-1",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference: firstExecution.reference,
      })
      const retry = yield* store.rescheduleJob({
        jobId: first.id,
        workerId: "agent-worker-1",
        failedAt: new Date("2026-07-20T12:01:03.000Z"),
        runAt: new Date("2026-07-20T12:01:04.000Z"),
        error: "retryable failure",
        maxAttempts: 2,
        execution: {
          attempt: first.attempt,
          leaseToken: firstExecution.intent.leaseToken,
        },
      })

      const second = yield* store.claimNextJob({
        workerId: "agent-worker-2",
        now: new Date("2026-07-20T12:02:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (second === null) throw new Error("expected second attempt")
      const secondExecution = makeExecution(
        second,
        "16666666-6666-4666-8666-666666666666",
        "26666666-6666-4666-8666-666666666666",
        "2026-07-20T12:02:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: second.id,
        workerId: "agent-worker-2",
        recordedAt: new Date("2026-07-20T12:02:01.000Z"),
        intent: secondExecution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: second.id,
        workerId: "agent-worker-2",
        recordedAt: new Date("2026-07-20T12:02:02.000Z"),
        reference: secondExecution.reference,
      })
      const failed = yield* store.rescheduleJob({
        jobId: second.id,
        workerId: "agent-worker-2",
        failedAt: new Date("2026-07-20T12:02:03.000Z"),
        runAt: new Date("2026-07-20T12:02:04.000Z"),
        error: "terminal failure",
        maxAttempts: 2,
        execution: {
          attempt: second.attempt,
          leaseToken: secondExecution.intent.leaseToken,
        },
      })
      const executions = yield* sql`
        SELECT attempt, state FROM agent_executions ORDER BY attempt
      `
      return { retry, failed, executions }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result).toEqual({
    retry: "retry",
    failed: "failed",
    executions: [
      { attempt: 1, state: "superseded" },
      { attempt: 2, state: "failed" },
    ],
  })
})

test("supersedes the session and rejects output from an older generation", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const sql = yield* SqlClient.SqlClient
      const baseEvent = decodePullRequestEvent({
        ...samplePullRequestEvent,
        pullRequest: {
          ...samplePullRequestEvent.pullRequest,
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      })
      yield* store.ingestPullRequest(
        {
          deliveryId: "agent-supersession-pr-1",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        baseEvent,
      )
      const work = yield* store.claimNextJob({
        workerId: "agent-worker",
        now: new Date("2026-07-20T12:01:00.000Z"),
        leaseDurationMs: 60_000,
      })
      if (work === null) throw new Error("expected review work")
      const execution = makeExecution(
        work,
        "14444444-4444-4444-8444-444444444444",
        "24444444-4444-4444-8444-444444444444",
        "2026-07-20T12:01:01.000Z",
      )
      yield* store.recordAgentLaunchIntent({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:01.000Z"),
        intent: execution.intent,
      })
      yield* store.recordAgentSessionReference({
        jobId: work.id,
        workerId: "agent-worker",
        recordedAt: new Date("2026-07-20T12:01:02.000Z"),
        reference: execution.reference,
      })
      yield* store.ingestPullRequest(
        {
          deliveryId: "agent-supersession-pr-2",
          event: "pull_request",
          action: "synchronize",
          payload: "{}",
          receivedAt: new Date("2026-07-20T12:01:03.000Z"),
        },
        decodePullRequestEvent({
          ...baseEvent,
          action: "synchronize",
          pullRequest: {
            ...baseEvent.pullRequest,
            headSha: "b".repeat(40),
            updatedAt: "2026-07-20T12:01:03.000Z",
          },
        }),
      )
      const late = yield* store.completeAgentReviewJob({
        jobId: work.id,
        workerId: "agent-worker",
        sessionReferenceId: execution.reference.sessionReferenceId,
        completedAt: new Date("2026-07-20T12:01:04.000Z"),
        review: { verdict: "pass", summary: "Stale output.", findings: [] },
        autoFix: false,
      })
      const cleanup = yield* store.claimExpiredAgentSession({
        workerId: "cleanup-worker",
        now: new Date("2026-07-20T12:01:04.000Z"),
        leaseDurationMs: 60_000,
      })
      const concurrentlyClaimed = yield* store.claimExpiredAgentSession({
        workerId: "other-cleanup-worker",
        now: new Date("2026-07-20T12:01:04.000Z"),
        leaseDurationMs: 60_000,
      })
      if (cleanup !== null) {
        yield* store.supersedeAgentSession(
          cleanup.sessionReferenceId,
          new Date("2026-07-20T12:01:05.000Z"),
        )
      }
      const executions = yield* sql`SELECT state FROM agent_executions`
      const publications = yield* sql`SELECT id FROM publications`
      return { cleanup, concurrentlyClaimed, late, executions, publications }
    }).pipe(Effect.provide(makeStoreLayer())),
  )

  expect(result.late).toBe("stale")
  expect(result.cleanup?.nativeSessionId).toBe("ses_1")
  expect(result.concurrentlyClaimed).toBeNull()
  expect(result.executions).toEqual([{ state: "superseded" }])
  expect(result.publications).toEqual([])
})
