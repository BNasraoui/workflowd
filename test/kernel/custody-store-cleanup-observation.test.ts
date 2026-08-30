import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")
const arrange = Effect.gen(function* () {
  const store = yield* KernelSessionStore
  yield* store.registerResource({
    resourceId: "r",
    owningHostId: "h",
    absolutePath: "/work",
    kind: "worktree",
    createdAt: now,
  })
  yield* store.registerSession({
    sessionId: "s",
    providerKind: "claude",
    providerVersion: 1,
    providerId: "p",
    serverId: "server",
    owningHostId: "h",
    endpointAlias: "private",
    endpointIdentity: "local",
    nativeSessionId: "native",
    resourceId: "r",
    createdAt: now,
  })
  const text = "{}"
  yield* store.registerResumeRequest({
    requestId: "q",
    sessionId: "s",
    owningHostId: "h",
    prompt: {},
    promptText: text,
    promptSha256: createHash("sha256").update(text).digest("hex"),
    outputContract: null,
    outputContractVersion: null,
    maxAttempts: 2,
    runAt: now,
    createdAt: now,
  })
})

describe("cleanup and observation lifecycle", () => {
  test("records terminal observation evidence and exposes latest observation", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* arrange
        const claim = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 1,
        })
        if (!claim) return yield* Effect.die(new Error("claim"))
        yield* store.markResumeSent({
          requestId: "q",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: claim.claimToken,
          expectedLeaseUntil: claim.leaseUntil,
          now,
        })
        yield* store.recoverExpiredResume({ owningHostId: "h", now: claim.leaseUntil })
        const observation = {
          requestId: "q",
          attempt: 1,
          observationId: "o",
          observerHostId: "h",
          observerWorkerId: "observer",
          observerToken: "observation-token",
          disposition: "missing" as const,
          evidenceVersion: 1,
          evidence: { lookup: "none" },
          observedAt: claim.leaseUntil,
        }
        yield* store.observeResume(observation)
        const replay = yield* store.observeResume(observation)
        const conflict = yield* store
          .observeResume({ ...observation, observationId: "other", disposition: "completed" })
          .pipe(Effect.result)
        const sql = yield* SqlClient.SqlClient
        const attempt = yield* sql`SELECT state FROM kernel_resume_attempts
          WHERE request_id = 'q' AND attempt = 1`
        return {
          attempt,
          conflict,
          observation: yield* store.readLatestObservation("q"),
          replay,
          request: yield* store.readResumeRequest("q"),
        }
      }),
    )
    expect(result.replay.status).toBe("duplicate")
    expect(result.conflict).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreConflictError" },
    })
    expect(result.attempt).toEqual([{ state: "failed" }])
    expect(result.observation).toMatchObject({ observation_id: "o", disposition: "missing" })
    expect(result.request).toMatchObject({ state: "failed" })
  })

  test("enforces mutual exclusion and completes resource-owned cleanup with host authority", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* arrange
        const resume = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        const blocked = yield* store
          .requestCleanup({
            cleanupId: "c",
            resourceId: "r",
            owningHostId: "h",
            reason: "cancelled",
            maxAttempts: 2,
            runAt: now,
            createdAt: now,
          })
          .pipe(Effect.result)
        if (!resume) return yield* Effect.die(new Error("claim"))
        yield* store.cancelResume({
          requestId: "q",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: resume.claimToken,
          expectedLeaseUntil: resume.leaseUntil,
          now: new Date(now.getTime() + 1),
        })
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "cancelled",
          maxAttempts: 2,
          runAt: now,
          createdAt: now,
        })
        const cleanup = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "janitor",
          now,
          leaseDurationMs: 60_000,
        })
        if (!cleanup) return yield* Effect.die(new Error("cleanup"))
        const completed = yield* store.completeCleanup({
          cleanupId: "c",
          attempt: cleanup.attempt,
          owningHostId: "h",
          workerId: "janitor",
          claimToken: cleanup.claimToken,
          expectedLeaseUntil: cleanup.leaseUntil,
          now: new Date(now.getTime() + 1),
          outcomeId: "out",
          disposition: "completed",
          outcomeVersion: 1,
          outcome: { removed: true },
        })
        return {
          blocked,
          cleanup,
          completed,
          resource: yield* store.readResource("r"),
          session: yield* store.readSession("s"),
        }
      }),
    )
    expect(result.blocked).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreConflictError" },
    })
    expect(result.cleanup).toMatchObject({ resourceId: "r", owningHostId: "h", attempt: 1 })
    expect(result.completed.status).toBe("completed")
    expect(result.resource).toMatchObject({ state: "cleaned" })
    expect(result.session).toMatchObject({ state: "cleaned" })
  })

  test("blocks cleanup while a ready resume would be stranded", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* arrange
        const cleanup = yield* store
          .requestCleanup({
            cleanupId: "c",
            resourceId: "r",
            owningHostId: "h",
            reason: "cancelled",
            maxAttempts: 2,
            runAt: now,
            createdAt: now,
          })
          .pipe(Effect.result)
        return {
          cleanup,
          request: yield* store.readResumeRequest("q"),
          resource: yield* store.readResource("r"),
        }
      }),
    )
    expect(result.cleanup).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreConflictError" },
    })
    expect(result.request).toMatchObject({ state: "ready" })
    expect(result.resource).toMatchObject({ state: "reserved" })
  })

  test("terminalizes operator-required observation on request, attempt, and session", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const claim = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 1,
        })
        if (!claim) return yield* Effect.die(new Error("claim"))
        yield* store.markResumeSent({
          requestId: "q",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: claim.claimToken,
          expectedLeaseUntil: claim.leaseUntil,
          now,
        })
        yield* store.recoverExpiredResume({ owningHostId: "h", now: claim.leaseUntil })
        yield* store.observeResume({
          requestId: "q",
          attempt: 1,
          observationId: "operator",
          observerHostId: "h",
          observerWorkerId: "observer",
          observerToken: "observation-token",
          disposition: "operator_required",
          evidenceVersion: 1,
          evidence: {},
          observedAt: claim.leaseUntil,
        })
        return {
          attempt: yield* sql`SELECT state FROM kernel_resume_attempts WHERE request_id = 'q'`,
          request: yield* store.readResumeRequest("q"),
          session: yield* store.readSession("s"),
        }
      }),
    )
    expect(result.attempt).toEqual([{ state: "operator_required" }])
    expect(result.request).toMatchObject({ state: "operator_required" })
    expect(result.session).toMatchObject({ state: "operator_required" })
  })
})
