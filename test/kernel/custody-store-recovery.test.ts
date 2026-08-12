import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody recovery", () => {
  test("quarantines poison resume data and continues with valid host work", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const sql = yield* SqlClient.SqlClient
        yield* store.registerResource({
          resourceId: "r",
          owningHostId: "h",
          absolutePath: "/work",
          kind: "workspace",
          createdAt: now,
        })
        yield* store.registerSession({
          sessionId: "s",
          providerKind: "opencode",
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
        for (const id of ["a-poison", "b-valid"]) {
          const text = JSON.stringify({ id })
          yield* store.registerResumeRequest({
            requestId: id,
            sessionId: "s",
            owningHostId: "h",
            prompt: { id },
            promptText: text,
            promptSha256: createHash("sha256").update(text).digest("hex"),
            outputContract: null,
            outputContractVersion: null,
            maxAttempts: 2,
            runAt: now,
            createdAt: now,
          })
        }
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_resume_requests SET prompt_json = '{bad' WHERE request_id = 'a-poison'`
        const claim = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        const poison =
          yield* sql`SELECT state FROM kernel_resume_requests WHERE request_id = 'a-poison'`
        return { claim, poison, recoverable: yield* store.readRecoverableResume("h") }
      }),
    )
    expect(result.claim).toMatchObject({ requestId: "b-valid" })
    expect(result.poison).toEqual([{ state: "data_error" }])
    expect(result.recoverable).toHaveLength(1)
  })

  test("returns host-scoped recoverable cleanup", async () => {
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
          maxAttempts: 2,
          runAt: now,
          createdAt: now,
        })
        return {
          own: yield* store.readRecoverableCleanup("h"),
          other: yield* store.readRecoverableCleanup("other"),
        }
      }),
    )
    expect(result.own).toHaveLength(1)
    expect(result.other).toEqual([])
  })

  test("quarantines malformed expired leased resume instead of reclaiming it", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const sql = yield* SqlClient.SqlClient
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
          maxAttempts: 2,
          runAt: now,
          createdAt: now,
        })
        const first = yield* store.claimResume({
          owningHostId: "h",
          workerId: "old",
          now,
          leaseDurationMs: 1,
        })
        if (!first) return yield* Effect.die(new Error("claim"))
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_resume_requests SET prompt_json = '{bad' WHERE request_id = 'q'`
        const replacement = yield* store.claimResume({
          owningHostId: "h",
          workerId: "new",
          now: first.leaseUntil,
          leaseDurationMs: 60_000,
        })
        return {
          replacement,
          request: yield* sql`SELECT state, attempt FROM kernel_resume_requests
        WHERE request_id = 'q'`,
        }
      }),
    )
    expect(result.replacement).toBeNull()
    expect(result.request).toEqual([{ state: "data_error", attempt: 1 }])
  })
})
