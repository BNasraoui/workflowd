import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")
const resume = (maxAttempts: number) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    yield* store.registerResource({
      resourceId: "r",
      owningHostId: "h",
      absolutePath: "/work",
      kind: "workspace",
      createdAt: now,
    })
    yield* store.registerSession({
      sessionId: "s",
      providerKind: "codex",
      providerVersion: 1,
      providerId: "p",
      serverId: "x",
      owningHostId: "h",
      endpointAlias: "a",
      endpointIdentity: "e",
      nativeSessionId: "n",
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
      maxAttempts,
      runAt: now,
      createdAt: now,
    })
    const claim = yield* store.claimResume({
      owningHostId: "h",
      workerId: "w",
      now,
      leaseDurationMs: 1,
    })
    if (!claim) return yield* Effect.die(new Error("claim"))
    return claim
  })

describe("custody attempt exhaustion", () => {
  test("final-attempt release becomes failed instead of stranded ready", async () => {
    const request = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const claim = yield* resume(1)
        yield* store.releaseResume({
          requestId: "q",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: claim.claimToken,
          expectedLeaseUntil: claim.leaseUntil,
          now,
          runAt: new Date(now.getTime() + 1),
        })
        return yield* store.readResumeRequest("q")
      }),
    )
    expect(request).toMatchObject({ state: "failed", attempt: 1 })
  })

  test("expired final unsent lease becomes failed", async () => {
    const request = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const claim = yield* resume(1)
        const replacement = yield* store.claimResume({
          owningHostId: "h",
          workerId: "new",
          now: claim.leaseUntil,
          leaseDurationMs: 60_000,
        })
        const sql = yield* SqlClient.SqlClient
        return {
          attempt: yield* sql`SELECT state FROM kernel_resume_attempts WHERE request_id = 'q'`,
          replacement,
          request: yield* store.readResumeRequest("q"),
        }
      }),
    )
    expect(request.replacement).toBeNull()
    expect(request.request).toMatchObject({ state: "failed", attempt: 1 })
    expect(request.attempt).toEqual([{ state: "failed" }])
  })

  test("final cleanup retry becomes operator-required", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* store.registerResource({
          resourceId: "r",
          owningHostId: "h",
          absolutePath: "/work",
          kind: "workspace",
          createdAt: now,
        })
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "done",
          maxAttempts: 1,
          runAt: now,
          createdAt: now,
        })
        const claim = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        if (!claim) return yield* Effect.die(new Error("cleanup"))
        const completion = {
          cleanupId: "c",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: claim.claimToken,
          expectedLeaseUntil: claim.leaseUntil,
          now,
          outcomeId: "retry",
          disposition: "retry" as const,
          outcomeVersion: 1,
          outcome: {},
          runAt: now,
        }
        yield* store.completeCleanup(completion)
        const replay = yield* store.completeCleanup(completion)
        return {
          cleanup: yield* store.readRecoverableCleanup("h"),
          replay,
          resource: yield* store.readResource("r"),
        }
      }),
    )
    expect(result.cleanup[0]).toMatchObject({ state: "operator_required" })
    expect(result.resource).toMatchObject({ state: "operator_required" })
    expect(result.replay.status).toBe("duplicate")
  })

  test("expired final cleanup lease becomes operator-required", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* store.registerResource({
          resourceId: "r",
          owningHostId: "h",
          absolutePath: "/work",
          kind: "workspace",
          createdAt: now,
        })
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "done",
          maxAttempts: 1,
          runAt: now,
          createdAt: now,
        })
        const claim = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "old",
          now,
          leaseDurationMs: 1,
        })
        if (!claim) return yield* Effect.die(new Error("cleanup"))
        const replacement = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "new",
          now: claim.leaseUntil,
          leaseDurationMs: 60_000,
        })
        return {
          cleanup: yield* store.readRecoverableCleanup("h"),
          replacement,
          resource: yield* store.readResource("r"),
        }
      }),
    )
    expect(result.replacement).toBeNull()
    expect(result.cleanup[0]).toMatchObject({ state: "operator_required" })
    expect(result.resource).toMatchObject({ state: "operator_required" })
  })
})
