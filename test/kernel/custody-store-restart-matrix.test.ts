import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { removeDatabase } from "./job-store-harness"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody restart matrix", () => {
  test("reopens all recoverable and terminal custody states", async () => {
    const file = `${process.cwd()}/custody-restart-${crypto.randomUUID()}.sqlite`
    try {
      await runSessionKernel(
        file,
        Effect.gen(function* () {
          const store = yield* KernelSessionStore
          const sql = yield* SqlClient.SqlClient
          for (const id of ["ready", "leased", "sent"]) {
            yield* store.registerResource({
              resourceId: `r-${id}`,
              owningHostId: "h",
              absolutePath: `/work/${id}`,
              kind: "workspace",
              createdAt: now,
            })
            yield* store.registerSession({
              sessionId: `s-${id}`,
              providerKind: "codex",
              providerVersion: 1,
              providerId: id,
              serverId: "x",
              owningHostId: "h",
              endpointAlias: "a",
              endpointIdentity: id,
              nativeSessionId: id,
              resourceId: `r-${id}`,
              createdAt: now,
            })
            const text = "{}"
            yield* store.registerResumeRequest({
              requestId: `q-${id}`,
              sessionId: `s-${id}`,
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
          }
          const leased = yield* store.claimResume({
            owningHostId: "h",
            workerId: "w",
            now,
            leaseDurationMs: 60_000,
          })
          const sent = yield* store.claimResume({
            owningHostId: "h",
            workerId: "w",
            now,
            leaseDurationMs: 1,
          })
          if (!leased || !sent) return yield* Effect.die(new Error("claims"))
          yield* store.markResumeSent({
            requestId: sent.requestId,
            attempt: sent.attempt,
            owningHostId: "h",
            workerId: "w",
            claimToken: sent.claimToken,
            expectedLeaseUntil: sent.leaseUntil,
            now,
          })
          yield* store.recoverExpiredResume({ owningHostId: "h", now: sent.leaseUntil })

          for (const id of ["required", "leased"]) {
            yield* store.registerResource({
              resourceId: `cleanup-${id}`,
              owningHostId: "h",
              absolutePath: `/cleanup/${id}`,
              kind: "workspace",
              createdAt: now,
            })
            yield* store.requestCleanup({
              cleanupId: `c-${id}`,
              resourceId: `cleanup-${id}`,
              owningHostId: "h",
              reason: "done",
              maxAttempts: 2,
              runAt: now,
              createdAt: now,
            })
          }
          yield* store.claimCleanup({
            owningHostId: "h",
            workerId: "janitor",
            now,
            leaseDurationMs: 60_000,
          })
          yield* sql`UPDATE kernel_sessions SET state = 'completed' WHERE session_id = 's-ready'`
          yield* sql`UPDATE kernel_sessions SET state = 'missing' WHERE session_id = 's-sent'`
        }),
      )

      const reopened = await runSessionKernel(
        file,
        Effect.gen(function* () {
          const store = yield* KernelSessionStore
          return {
            cleanup: yield* store.readRecoverableCleanup("h"),
            cleanupLeased: yield* store.readResource("cleanup-leased"),
            cleanupRequired: yield* store.readResource("cleanup-required"),
            completed: yield* store.readSession("s-ready"),
            missing: yield* store.readSession("s-sent"),
            resumes: yield* store.readRecoverableResume("h"),
          }
        }),
      )
      expect(reopened.resumes.map((row) => row.state).sort()).toEqual([
        "leased",
        "observation_required",
        "ready",
      ])
      expect(reopened.cleanup.map((row) => row.state).sort()).toEqual(["leased", "pending"])
      expect(reopened.cleanupRequired).toMatchObject({ state: "cleanup_required" })
      expect(reopened.cleanupLeased).toMatchObject({ state: "cleanup_leased" })
      expect(reopened.completed).toMatchObject({ state: "completed" })
      expect(reopened.missing).toMatchObject({ state: "missing" })
    } finally {
      await removeDatabase(file)
    }
  })
})
