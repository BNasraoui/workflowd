import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody row decoding", () => {
  test("returns typed data errors for malformed resource, session, request, observation, and result rows", async () => {
    const tags = await runSessionKernel(
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
          maxAttempts: 1,
          runAt: now,
          createdAt: now,
        })
        yield* sql`PRAGMA ignore_check_constraints = ON`
        const reads = [
          sql`UPDATE kernel_working_resources SET created_at = 'bad' WHERE resource_id = 'r'`.pipe(
            Effect.andThen(store.readResource("r")),
          ),
          sql`UPDATE kernel_sessions SET revision = 0 WHERE session_id = 's'`.pipe(
            Effect.andThen(store.readSession("s")),
          ),
          sql`UPDATE kernel_resume_requests SET prompt_json = '{bad' WHERE request_id = 'q'`.pipe(
            Effect.andThen(store.readResumeRequest("q")),
          ),
        ]
        return yield* Effect.forEach(reads, (read) =>
          read.pipe(
            Effect.result,
            Effect.map((result) => result._tag === "Failure" && result.failure._tag),
          ),
        )
      }),
    )
    expect(tags).toEqual(Array.from({ length: 3 }, () => "KernelSessionStoreDataError"))
  })

  test("quarantines a claim row with malformed non-JSON fields and continues", async () => {
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
        yield* sql`UPDATE kernel_resume_requests SET max_attempts = 0 WHERE request_id = 'a-poison'`
        const claim = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        return {
          claim,
          poison:
            yield* sql`SELECT state FROM kernel_resume_requests WHERE request_id = 'a-poison'`,
        }
      }),
    )
    expect(result.claim).toMatchObject({ requestId: "b-valid" })
    expect(result.poison).toEqual([{ state: "data_error" }])
  })

  test("returns typed data errors from malformed recoverable rows", async () => {
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
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "done",
          maxAttempts: 2,
          runAt: now,
          createdAt: now,
        })
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_cleanup_requests SET run_at = 'bad' WHERE cleanup_id = 'c'`
        return yield* store.readRecoverableCleanup("h").pipe(Effect.result)
      }),
    )
    expect(result).toMatchObject({ _tag: "Failure", left: { _tag: "KernelSessionStoreDataError" } })
  })

  test("quarantines malformed cleanup claim rows", async () => {
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
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "done",
          maxAttempts: 2,
          runAt: now,
          createdAt: now,
        })
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_cleanup_requests SET max_attempts = 0 WHERE cleanup_id = 'c'`
        const claim = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        return {
          claim,
          row: yield* sql`SELECT state FROM kernel_cleanup_requests WHERE cleanup_id = 'c'`,
        }
      }),
    )
    expect(result.claim).toBeNull()
    expect(result.row).toEqual([{ state: "data_error" }])
  })
})
