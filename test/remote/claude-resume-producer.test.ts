import { expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { KernelJobStore } from "../../src/kernel/job-store"
import {
  ClaudeResumePromptTooLarge,
  ClaudeResumeRemoteProducer,
  ClaudeResumeRemoteProducerLive,
} from "../../src/remote/claude-resume-producer"
import { MAX_CLAUDE_RESUME_PROMPT_BYTES } from "../../src/remote/contract"
import { now, runKernel } from "../kernel/job-store-harness"

const payload = {
  kind: "claude_resume" as const,
  hostId: "host-a",
  nativeSessionId: "0c0ffee0-cafe-4dad-b0ba-000000000001",
  directory: "/home/example/repos/workflowd",
  prompt: '{"task":"WAKE: the child finished."}',
  extractionSchemaJson: '{"type":"object"}',
  turnTimeoutMs: 120_000,
}

test("claude resume producer enqueues a single-attempt remote job on the remote lane", async () => {
  const result = await runKernel(
    ":memory:",
    Effect.gen(function* () {
      const producer = yield* ClaudeResumeRemoteProducer
      const jobs = yield* KernelJobStore
      const submitted = yield* producer.enqueue({ requestId: "resume-1", attempt: 1, payload }, now)
      const ordinary = yield* jobs.claimNext({
        workerId: "ordinary",
        now,
        leaseDurationMs: 60_000,
      })
      const remote = yield* jobs.claimRemote({
        workerId: "remote-coordinator",
        now,
        leaseDurationMs: 60_000,
      })
      return { submitted, ordinary, remote }
    }).pipe(Effect.provide(ClaudeResumeRemoteProducerLive)),
  )

  expect(result.submitted).toMatchObject({
    status: "enqueued",
    jobId: "claude-resume-remote-resume-1-a1",
  })
  // The wake never rides the local job lane; only the remote coordinator
  // claims it, and with exactly one delivery attempt.
  expect(result.ordinary).toBeNull()
  expect(result.remote).toMatchObject({
    jobId: "claude-resume-remote-resume-1-a1",
    inputVersion: 1,
    maxAttempts: 1,
    input: payload,
  })
})

test("claude resume producer is idempotent and refuses divergent replays", async () => {
  const result = await runKernel(
    ":memory:",
    Effect.gen(function* () {
      const producer = yield* ClaudeResumeRemoteProducer
      const first = yield* producer.enqueue({ requestId: "resume-2", attempt: 1, payload }, now)
      const duplicate = yield* producer.enqueue({ requestId: "resume-2", attempt: 1, payload }, now)
      const conflict = yield* producer
        .enqueue(
          { requestId: "resume-2", attempt: 1, payload: { ...payload, hostId: "host-b" } },
          now,
        )
        .pipe(Effect.result)
      return { first, duplicate, conflict }
    }).pipe(Effect.provide(ClaudeResumeRemoteProducerLive)),
  )

  expect(result.first.status).toBe("enqueued")
  expect(result.duplicate.status).toBe("duplicate")
  expect(result.conflict._tag).toBe("Failure")
})

test("a prompt over the remote budget is refused before anything durable exists", async () => {
  const result = await runKernel(
    ":memory:",
    Effect.gen(function* () {
      const producer = yield* ClaudeResumeRemoteProducer
      const jobs = yield* KernelJobStore
      const refused = yield* producer
        .enqueue(
          {
            requestId: "resume-3",
            attempt: 1,
            payload: { ...payload, prompt: "x".repeat(MAX_CLAUDE_RESUME_PROMPT_BYTES + 1) },
          },
          now,
        )
        .pipe(Effect.result)
      const remote = yield* jobs.claimRemote({
        workerId: "remote-coordinator",
        now,
        leaseDurationMs: 60_000,
      })
      return { refused, remote }
    }).pipe(Effect.provide(ClaudeResumeRemoteProducerLive)),
  )

  expect(Result.isFailure(result.refused)).toBe(true)
  if (Result.isFailure(result.refused)) {
    expect(result.refused.failure).toBeInstanceOf(ClaudeResumePromptTooLarge)
  }
  expect(result.remote).toBeNull()
})
