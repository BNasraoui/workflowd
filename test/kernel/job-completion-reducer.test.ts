import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { enqueueNextJobCompletionResume } from "../../src/kernel/job-completion-reducer"
import { KernelJobStore, KernelJobStoreLive } from "../../src/kernel/job-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { RemoteProbeProducer, RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { WorkflowStoreLive } from "../../src/store"

const at = new Date("2026-08-20T12:00:00.000Z")

const layer = (() => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const jobs = KernelJobStoreLive.pipe(Layer.provideMerge(events), Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const producer = RemoteProbeProducerLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(jobs),
    Layer.provideMerge(bootstrap),
  )
  return Layer.mergeAll(events, jobs, sessions, producer)
})()

test("matched job completion delivery creates one OpenCode session resume job", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const jobs = yield* KernelJobStore
      const sessions = yield* KernelSessionStore
      const producer = yield* RemoteProbeProducer
      yield* sessions.registerResource({
        resourceId: "resume-resource",
        owningHostId: "mint",
        absolutePath: process.cwd(),
        kind: "worktree",
        createdAt: at,
      })
      yield* sessions.registerSession({
        sessionId: "resume-session",
        providerKind: "opencode",
        providerVersion: 1,
        providerId: "opencode-primary",
        serverId: "server-a",
        owningHostId: "mint",
        endpointAlias: "local",
        endpointIdentity: "http://127.0.0.1:4096",
        nativeSessionId: "ses_resume",
        resourceId: "resume-resource",
        createdAt: at,
      })
      yield* producer.enqueue(
        {
          probeId: "reducer-probe",
          hostId: "runner-a",
          resume: { provider: "opencode", sessionId: "resume-session", host: "mint" },
        },
        at,
      )
      const probe = yield* jobs.claimRemoteProbe({
        workerId: "coordinator",
        now: at,
        leaseDurationMs: 60_000,
      })
      if (probe === null) return yield* Effect.die(new Error("expected a remote probe claim"))
      yield* jobs.complete({
        jobId: probe.jobId,
        workerId: probe.workerId,
        attempt: probe.attempt,
        claimToken: probe.claimToken,
        expectedLeaseUntil: probe.leaseUntil,
        now: at,
        resultId: "reducer-result",
        resultVersion: 1,
        result: { status: "healthy" },
      })
      const first = yield* enqueueNextJobCompletionResume(at)
      const second = yield* enqueueNextJobCompletionResume(at)
      const claim = yield* jobs.claimNext({
        workerId: "resume-worker",
        now: at,
        leaseDurationMs: 60_000,
      })
      return { first, second, claim }
    }).pipe(Effect.provide(layer)),
  )

  const resumeJobId = "remote-probe-resume-instance-reducer-probe:resume-session"
  expect(result.first).toEqual({ status: "enqueued", jobId: resumeJobId })
  expect(result.second).toEqual({ status: "idle" })
  expect(result.claim).toMatchObject({
    jobId: resumeJobId,
    input: {
      kind: "resume_parent_agent",
      parentSessionId: "resume-session",
      resumePrompt: {
        kind: "workflowd.job.completed",
        jobId: "remote-probe-reducer-probe",
        outcome: "succeeded",
        result: { status: "healthy" },
        completedAt: at.toISOString(),
      },
      outputContract: "workflowd.job.completed",
      outputContractVersion: 1,
    },
  })
})
