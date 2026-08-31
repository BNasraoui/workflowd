import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer } from "effect"
import {
  ClaudeResumeExecutor,
  type ClaudeResumeExecutorPort,
  type ClaudeResumeOutcome,
} from "../../src/remote/claude-resume-executor"
import { encodeRemoteCommand, encodeRemoteFence } from "../../src/remote/codec"
import type { ClaudeResumeJobV1, RemoteCommand } from "../../src/remote/contract"
import { RemoteRunnerStore, RemoteRunnerStoreLive } from "../../src/remote/runner-store"
import { now } from "../kernel/job-store-harness"

const jobPayload: ClaudeResumeJobV1 = {
  kind: "claude_resume",
  hostId: "ben-arch",
  nativeSessionId: "abc-123",
  directory: "/allowed/work",
  prompt: "wake up",
  extractionSchemaJson: '{"type":"object"}',
  turnTimeoutMs: 120_000,
}

const command = {
  version: 1 as const,
  commandId: "cmd-1",
  jobId: "job-1",
  attempt: 1,
  generation: 1,
  hostId: "ben-arch",
  kind: "claude_resume" as const,
  payload: jobPayload,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 600_000).toISOString(),
} satisfies RemoteCommand

const fence = {
  version: 1 as const,
  kind: "fence" as const,
  jobId: "job-1",
  generation: 1,
  hostId: "ben-arch",
  disposition: "current" as const,
  issuedAt: now.toISOString(),
}

const countingExecutor = (
  outcome: ClaudeResumeOutcome,
  runs: { count: number },
): ClaudeResumeExecutorPort => ({
  execute: () =>
    Effect.sync(() => {
      runs.count += 1
      return outcome
    }),
})

const deliver = Effect.gen(function* () {
  const store = yield* RemoteRunnerStore
  const fenceBytes = yield* encodeRemoteFence(fence)
  const commandBytes = yield* encodeRemoteCommand(command)
  yield* store.recordBatch(
    "ben-arch",
    [{ deliveryId: "d-fence", data: fenceBytes, message: fence }],
    now,
  )
  yield* store.recordBatch(
    "ben-arch",
    [{ deliveryId: "d-cmd", data: commandBytes, message: command }],
    now,
  )
})

const layer = (executor: ClaudeResumeExecutorPort) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  return RemoteRunnerStoreLive.pipe(
    Layer.provideMerge(database),
    Layer.provide(Layer.succeed(ClaudeResumeExecutor, executor)),
  )
}

describe("runner store claude_resume at-most-once", () => {
  test("executes once, then replays the stored result on redelivery without re-running", async () => {
    const runs = { count: 0 }
    const ack = '{"acknowledged":true,"summary":"ok"}'
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* RemoteRunnerStore
        yield* deliver
        const first = yield* store.executeClaudeResume(command, now)
        const second = yield* store.executeClaudeResume(command, now)
        return { first, second }
      }).pipe(Effect.provide(layer(countingExecutor({ status: "succeeded", output: ack }, runs)))),
    )
    expect(runs.count).toBe(1)
    expect(result.first).toMatchObject({ kind: "claude_resume", status: "succeeded", output: ack })
    expect(result.second).toEqual(result.first)
  })

  test("a spent claim with no stored result reports execution_interrupted, never re-running", async () => {
    const runs = { count: 0 }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* RemoteRunnerStore
        const sql = yield* SqlClient.SqlClient
        yield* deliver
        // Simulate a crash after the execution claim but before the result:
        // execution_count is 1, no outbox row exists.
        yield* sql`UPDATE remote_runner_inbox SET execution_count = 1 WHERE command_id = 'cmd-1'`
        const outcome = yield* store.executeClaudeResume(command, now)
        return outcome
      }).pipe(Effect.provide(layer(countingExecutor({ status: "succeeded", output: "{}" }, runs)))),
    )
    expect(runs.count).toBe(0)
    expect(result).toMatchObject({
      kind: "claude_resume",
      status: "failed",
      failureReason: "execution_interrupted",
    })
  })

  test("a failed execution is stored and published like any result", async () => {
    const runs = { count: 0 }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* RemoteRunnerStore
        yield* deliver
        const outcome = yield* store.executeClaudeResume(command, now)
        const pending = yield* store.pendingResults()
        return { outcome, pending }
      }).pipe(
        Effect.provide(
          layer(countingExecutor({ status: "failed", failureReason: "transcript_missing" }, runs)),
        ),
      ),
    )
    expect(result.outcome).toMatchObject({ status: "failed", failureReason: "transcript_missing" })
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]).toMatchObject({ commandId: "cmd-1", status: "failed" })
  })
})
