import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer } from "effect"
import {
  AgentHandoffStore,
  AgentHandoffStoreLive,
  recordAgentSessionCompletion,
} from "../../src/kernel/agent-handoff-store"
import { enqueueNextAgentHandoff } from "../../src/kernel/agent-handoff-reducer"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelJobStore, KernelJobStoreLive } from "../../src/kernel/job-store"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { McpQueries, McpQueriesLive } from "../../src/mcp/queries"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

const at = new Date("2026-08-14T09:00:00.000Z")

const layer = (() => {
  const bootstrap = WorkflowStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )
  const kernel = Layer.mergeAll(
    KernelEventStoreLive,
    KernelJobStoreLive,
    KernelSessionStoreLive,
    AgentRunStoreLive,
  ).pipe(Layer.provideMerge(bootstrap))
  return AgentHandoffStoreLive.pipe(Layer.provideMerge(kernel))
})()

const arrangeDelivery = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  const source = {
    providerKind: "opencode" as const,
    providerVersion: 1,
    providerId: "opencode-primary",
    serverId: "server-a",
    owningHostId: "mint",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    createdAt: at,
  }
  for (const name of ["child", "parent"] as const) {
    yield* sessions.registerResource({
      resourceId: `${name}-resource`,
      owningHostId: "mint",
      absolutePath: name === "child" ? process.cwd() : `${process.cwd()}/src`,
      kind: "worktree",
      createdAt: at,
    })
    yield* sessions.registerSession({
      ...source,
      sessionId: `${name}-stable`,
      nativeSessionId: `ses_${name}`,
      resourceId: `${name}-resource`,
    })
  }
  const handoffs = yield* AgentHandoffStore
  const continuation = {
    resumePrompt: { task: "Continue exactly." },
    resumePromptText: '{"task":"Continue exactly."}',
    outputContract: "test.parent-result",
    outputContractVersion: 1,
    retryPolicy: { maxAttempts: 3 },
  }
  yield* handoffs.register({
    instanceId: "handoff-1",
    waitId: "wait-child",
    workflow: {
      ...continuation,
      kind: "wait_for_agent",
      childSessionId: "child-stable",
      childSessionGeneration: 1,
      parentSessionId: "parent-stable",
    },
    completionSource: source,
    registeredAt: at,
  })
  yield* recordAgentSessionCompletion({
    source: "test-source",
    sourceEventId: "terminal-1",
    childSessionId: "child-stable",
    childSessionGeneration: 1,
    completionId: "completion-1",
    completedAt: at,
  })
})

describe("agent handoff reducer", () => {
  test("passes the terminal mailbox result and caller task to the resume job once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* arrangeDelivery
        const runs = yield* AgentRunStore
        yield* runs.create({
          runId: "run-child",
          route: "scan",
          providerId: "codex-cli",
          modelId: "model",
          executorKind: "codex",
          agent: "build",
          repository: "o/r",
          directory: process.cwd(),
          prompt: "task",
          promptSha256: "a".repeat(64),
          parentSessionId: "parent-stable",
          resumePrompt: "Continue exactly.",
          maxAttempts: 1,
          createdAt: at,
        })
        yield* runs.claimSpawn({ runId: "run-child", now: at })
        yield* runs.markSpawned({
          runId: "run-child",
          resourceId: "child-resource",
          sessionId: "child-stable",
          nativeSessionId: "ses_child",
          now: at,
        })
        yield* runs.markVerified({ runId: "run-child", outputTokens: 1, now: at })
        yield* runs.complete({ runId: "run-child", now: at, finalMessage: "Finished the patch." })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_sessions SET state = 'operator_required' WHERE session_id = 'parent-stable'`
        yield* enqueueNextAgentHandoff(at)
        const child = yield* runs.read("run-child")
        const messages = yield* (yield* McpQueries).readAgentMailbox(child!.callerMailboxId)
        yield* sql`UPDATE kernel_sessions SET state = 'ready' WHERE session_id = 'parent-stable'`
        const first = yield* enqueueNextAgentHandoff(at)
        const second = yield* enqueueNextAgentHandoff(at)
        const jobs = yield* sql<{
          input_json: string
        }>`SELECT input_json FROM kernel_workflow_jobs WHERE job_id = 'handoff-1:resume-parent'`
        return { first, second, jobs, messages }
      }).pipe(Effect.provide(McpQueriesLive.pipe(Layer.provideMerge(layer)))),
    )
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]).toMatchObject({
      kind: "agent_wake_failed",
      reason: "parent_custody_unavailable",
    })
    expect(result.first.status).toBe("enqueued")
    expect(result.second.status).toBe("idle")
    const prompt = JSON.parse(result.jobs[0]!.input_json).resumePrompt
    expect(prompt.task).toBe("Continue exactly.")
    expect(prompt.terminal).toMatchObject({
      run_id: "run-child",
      status: "completed",
      end_reason: "completed",
      final_message: "Finished the patch.",
    })
    expect(prompt.terminal.mailbox_id).toMatch(/^agent-mailbox-/)
  })

  test("atomically consumes one delivery into one durable parent-resume action", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeDelivery
        const first = yield* enqueueNextAgentHandoff(at)
        const second = yield* enqueueNextAgentHandoff(at)
        return {
          first,
          second,
          job: yield* jobs.readJob("handoff-1:resume-parent"),
          request: yield* (yield* KernelSessionStore).readResumeRequest(
            "handoff-1:resume-parent:request",
          ),
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.first).toEqual({ status: "enqueued", jobId: "handoff-1:resume-parent" })
    expect(result.second).toEqual({ status: "idle" })
    expect(result.job).toMatchObject({ state: "ready", maxAttempts: 3 })
    expect(result.request).toMatchObject({ state: "ready", session_id: "parent-stable" })
  })

  test("keeps a Claude wait recoverable when an earlier wake blocked the parent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* arrangeDelivery
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_sessions SET provider_kind = 'claude',
          state = 'operator_required' WHERE session_id = 'parent-stable'`
        const blocked = yield* enqueueNextAgentHandoff(at)
        const waits = yield* sql`SELECT state FROM kernel_waits WHERE wait_id = 'wait-child'`
        const requests = yield* sql`SELECT request_id FROM kernel_resume_requests`
        const messages = yield* sql<{ prompt: string }>`SELECT prompt FROM resident_inbox
          WHERE mailbox_id = 'agent-wake-mailbox-parent-stable'`
        yield* enqueueNextAgentHandoff(at)
        const notices = yield* sql`SELECT id FROM resident_inbox`
        yield* sql`UPDATE kernel_sessions SET state = 'ready' WHERE session_id = 'parent-stable'`
        const recovered = yield* enqueueNextAgentHandoff(at)
        const request = yield* (yield* KernelSessionStore).readResumeRequest(
          "handoff-1:resume-parent:request",
        )
        return { blocked, waits, requests, messages, notices, recovered, request }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.blocked.status).toBe("idle")
    expect(result.waits[0]?.state).not.toBe("consumed")
    expect(result.requests).toHaveLength(0)
    expect(JSON.parse(result.messages[0]!.prompt)).toMatchObject({
      kind: "agent_wake_failed",
      reason: "parent_custody_unavailable",
      parent_session_id: "parent-stable",
    })
    expect(result.notices).toHaveLength(1)
    expect(result.recovered.status).toBe("enqueued")
    expect(result.request).toMatchObject({ state: "ready" })
  })

  test("rolls back the resume request if consuming the wait fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* arrangeDelivery
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER reject_handoff BEFORE INSERT ON kernel_workflow_jobs
          BEGIN SELECT RAISE(ABORT, 'injected enqueue failure'); END`
        const failed = yield* enqueueNextAgentHandoff(at).pipe(Effect.result)
        const requests = yield* sql`SELECT request_id FROM kernel_resume_requests`
        const waits = yield* sql`SELECT state FROM kernel_waits WHERE wait_id = 'wait-child'`
        yield* sql`DROP TRIGGER reject_handoff`
        yield* enqueueNextAgentHandoff(at)
        const recovered = yield* sql`SELECT request_id FROM kernel_resume_requests`
        return { failed, requests, waits, recovered }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.failed._tag).toBe("Failure")
    expect(result.requests).toHaveLength(0)
    expect(result.waits[0]?.state).not.toBe("consumed")
    expect(result.recovered).toHaveLength(1)
  })

  test("registers exactly one saved resume request and wakes its lane after commit", async () => {
    const wakes: Array<string> = []
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: (lane) => Effect.sync(() => void wakes.push(lane)),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* KernelSessionStore
        yield* arrangeDelivery
        yield* enqueueNextAgentHandoff(at)
        const iteration = yield* runKernelJobIteration({
          workerId: "handoff-worker",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return {
          iteration,
          request: yield* sessions.readResumeRequest("handoff-1:resume-parent:request"),
        }
      }).pipe(Effect.provide(layer), Effect.provideService(WorkSignal, signals)),
    )

    expect(result.iteration).toEqual({ status: "completed", jobId: "handoff-1:resume-parent" })
    expect(result.request).toMatchObject({
      session_id: "parent-stable",
      prompt_text: '{"task":"Continue exactly."}',
      state: "ready",
    })
    expect(wakes).toEqual(["session-resume"])
  })

  for (const legacy of [false, true]) {
    test(`a parent blocked after wait consumption retains ${legacy ? "a visible legacy failure" : "its saved request"}`, async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* arrangeDelivery
          yield* enqueueNextAgentHandoff(at)
          const sql = yield* SqlClient.SqlClient
          if (legacy) yield* sql`DELETE FROM kernel_resume_requests`
          yield* sql`UPDATE kernel_sessions SET state = 'operator_required' WHERE session_id = 'parent-stable'`
          const iteration = yield* runKernelJobIteration({
            workerId: "handoff",
            now: () => at,
            leaseDurationMs: 60_000,
            retryDelayMs: 0,
          })
          const requests = yield* sql`SELECT request_id FROM kernel_resume_requests`
          const messages = yield* sql<{ prompt: string }>`SELECT prompt FROM resident_inbox`
          return { iteration, requests, messages }
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(WorkSignal, {
            subscribe: () => Effect.die("unused"),
            wake: () => Effect.void,
          }),
        ),
      )
      expect(result.iteration.status).toBe(legacy ? "operator_required" : "completed")
      expect(result.requests).toHaveLength(legacy ? 0 : 1)
      if (legacy)
        expect(JSON.parse(result.messages[0]!.prompt)).toMatchObject({ kind: "agent_wake_failed" })
    })
  }

  test("replays harmlessly after crashing between resume registration and job completion", async () => {
    let crash = true
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* KernelSessionStore
        yield* arrangeDelivery
        yield* enqueueNextAgentHandoff(at)
        const first = yield* runKernelJobIteration({
          workerId: "handoff-worker-a",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 0,
          afterResumeRegistered: () => {
            if (crash) {
              crash = false
              return Effect.fail(new Error("injected post-registration crash"))
            }
            return Effect.void
          },
        })
        const second = yield* runKernelJobIteration({
          workerId: "handoff-worker-b",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 0,
        })
        return {
          first,
          second,
          recoverable: yield* sessions.readRecoverableResume("mint"),
        }
      }).pipe(Effect.provide(layer), Effect.provideService(WorkSignal, signals)),
    )

    expect(result.first).toMatchObject({ status: "retry_scheduled" })
    expect(result.second).toMatchObject({ status: "completed" })
    expect(result.recoverable).toHaveLength(1)
    expect(result.recoverable[0]).toMatchObject({ request_id: "handoff-1:resume-parent:request" })
  })
})
