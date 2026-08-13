import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"
import { removeDatabase } from "./job-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")
const arrange = () =>
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
      maxAttempts: 3,
      runAt: now,
      createdAt: now,
    })
    const claim = yield* store.claimCleanup({
      owningHostId: "h",
      workerId: "w",
      now,
      leaseDurationMs: 60_000,
    })
    if (!claim) return yield* Effect.die(new Error("claim"))
    return claim
  })

describe("cleanup authority", () => {
  test("rejects every stale authority dimension and exact expiry", async () => {
    const tags = await Promise.all(
      ["host", "worker", "attempt", "token", "deadline", "expiry"].map((dimension) =>
        runSessionKernel(
          ":memory:",
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            const claim = yield* arrange()
            const base = {
              cleanupId: "c",
              attempt: 1,
              owningHostId: "h",
              workerId: "w",
              claimToken: claim.claimToken,
              expectedLeaseUntil: claim.leaseUntil,
              now: new Date(now.getTime() + 1),
            }
            const changed =
              dimension === "host"
                ? { ...base, owningHostId: "other" }
                : dimension === "worker"
                  ? { ...base, workerId: "other" }
                  : dimension === "attempt"
                    ? { ...base, attempt: 2 }
                    : dimension === "token"
                      ? { ...base, claimToken: "other" }
                      : dimension === "deadline"
                        ? { ...base, expectedLeaseUntil: new Date(claim.leaseUntil.getTime() + 1) }
                        : { ...base, now: claim.leaseUntil }
            const result = yield* store
              .completeCleanup({
                ...changed,
                outcomeId: "o",
                disposition: "completed",
                outcomeVersion: 1,
                outcome: {},
              })
              .pipe(Effect.either)
            return result._tag === "Left" && result.left._tag
          }),
        ),
      ),
    )
    expect(tags).toEqual(Array.from({ length: 6 }, () => "KernelSessionStoreAuthorityError"))
  })

  test("retries with a fresh token and incremented attempt", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const first = yield* arrange()
        const runAt = new Date(now.getTime() + 2)
        yield* store.completeCleanup({
          cleanupId: "c",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: first.claimToken,
          expectedLeaseUntil: first.leaseUntil,
          now: new Date(now.getTime() + 1),
          outcomeId: "retry",
          disposition: "retry",
          outcomeVersion: 1,
          outcome: {},
          runAt,
        })
        const second = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "w2",
          now: runAt,
          leaseDurationMs: 60_000,
        })
        const sql = yield* SqlClient.SqlClient
        return {
          attempts: yield* sql`SELECT attempt, state FROM kernel_cleanup_attempts
        WHERE cleanup_id = 'c' ORDER BY attempt`,
          first,
          second,
        }
      }),
    )
    expect(result.second).toMatchObject({ attempt: 2, workerId: "w2" })
    expect(result.second?.claimToken).not.toBe(result.first.claimToken)
    expect(result.attempts).toEqual([
      { attempt: 1, state: "retry" },
      { attempt: 2, state: "leased" },
    ])
  })

  test("persists retry and later terminal outcomes independently per attempt", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const first = yield* arrange()
        const runAt = new Date(now.getTime() + 2)
        yield* store.completeCleanup({
          cleanupId: "c",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: first.claimToken,
          expectedLeaseUntil: first.leaseUntil,
          now: new Date(now.getTime() + 1),
          outcomeId: "retry",
          disposition: "retry",
          outcomeVersion: 1,
          outcome: { retry: true },
          runAt,
        })
        const second = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "w2",
          now: runAt,
          leaseDurationMs: 60_000,
        })
        if (!second) return yield* Effect.die(new Error("second"))
        const terminal = yield* store.completeCleanup({
          cleanupId: "c",
          attempt: 2,
          owningHostId: "h",
          workerId: "w2",
          claimToken: second.claimToken,
          expectedLeaseUntil: second.leaseUntil,
          now: new Date(runAt.getTime() + 1),
          outcomeId: "terminal",
          disposition: "completed",
          outcomeVersion: 1,
          outcome: { removed: true },
        })
        return { resource: yield* store.readResource("r"), terminal }
      }),
    )
    expect(result.terminal.status).toBe("completed")
    expect(result.resource).toMatchObject({ state: "cleaned" })
  })

  test("reclaims an expired cleanup lease with fresh authority", async () => {
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
          maxAttempts: 3,
          runAt: now,
          createdAt: now,
        })
        const first = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "old",
          now,
          leaseDurationMs: 1,
        })
        if (!first) return yield* Effect.die(new Error("claim"))
        const second = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "new",
          now: first.leaseUntil,
          leaseDurationMs: 60_000,
        })
        return { first, second }
      }),
    )
    expect(result.second).toMatchObject({ attempt: 2, workerId: "new" })
    expect(result.second?.claimToken).not.toBe(result.first.claimToken)
  })

  test("independent clients allow exactly one cleanup claimant", async () => {
    const file = `${process.cwd()}/cleanup-race-${crypto.randomUUID()}.sqlite`
    try {
      await runSessionKernel(
        file,
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
            maxAttempts: 2,
            runAt: now,
            createdAt: now,
          })
        }),
      )
      const claim = (workerId: string) =>
        runSessionKernel(
          file,
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            return yield* store.claimCleanup({
              owningHostId: "h",
              workerId,
              now,
              leaseDurationMs: 60_000,
            })
          }),
        )
      const claims = await Promise.all([claim("a"), claim("b")])
      expect(claims.filter(Boolean)).toHaveLength(1)
    } finally {
      await removeDatabase(file)
    }
  })
})
