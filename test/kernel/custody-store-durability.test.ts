import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { KernelSessionStore, MAX_CUSTODY_JSON_BYTES } from "../../src/kernel/session-store"
import { removeDatabase } from "./job-store-harness"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")
const arrange = (requestId = "q") =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    yield* store.registerResource({
      resourceId: "r",
      owningHostId: "h",
      absolutePath: "/work",
      kind: "checkout",
      createdAt: now,
    })
    yield* store.registerSession({
      sessionId: "s",
      providerKind: "opencode",
      providerVersion: 1,
      providerId: "p",
      serverId: "server",
      owningHostId: "h",
      endpointAlias: "a",
      endpointIdentity: "e",
      nativeSessionId: "n",
      resourceId: "r",
      createdAt: now,
    })
    const text = "{}"
    yield* store.registerResumeRequest({
      requestId,
      sessionId: "s",
      owningHostId: "h",
      prompt: {},
      promptText: text,
      promptSha256: createHash("sha256").update(text).digest("hex"),
      outputContract: null,
      outputContractVersion: null,
      maxAttempts: 3,
      runAt: now,
      createdAt: now,
    })
  })

describe("custody durability", () => {
  test("races resume claims and completions across independent clients", async () => {
    const file = `${process.cwd()}/custody-${crypto.randomUUID()}.sqlite`
    try {
      await runSessionKernel(file, arrange())
      const claim = (workerId: string) =>
        runSessionKernel(
          file,
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            return yield* store.claimResume({
              owningHostId: "h",
              workerId,
              now,
              leaseDurationMs: 60_000,
            })
          }),
        )
      const claims = await Promise.all([claim("a"), claim("b")])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const accepted = claims.find(Boolean)!
      const complete = () =>
        runSessionKernel(
          file,
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            return yield* store.completeResume({
              requestId: "q",
              attempt: 1,
              owningHostId: "h",
              workerId: accepted.workerId,
              claimToken: accepted.claimToken,
              expectedLeaseUntil: accepted.leaseUntil,
              now: new Date(now.getTime() + 1),
              resultId: "result",
              resultVersion: 1,
              result: { ok: true },
            })
          }),
        )
      expect((await Promise.all([complete(), complete()])).map((x) => x.status).sort()).toEqual([
        "completed",
        "duplicate",
      ])
    } finally {
      await removeDatabase(file)
    }
  })

  test("rolls back claim when attempt insertion fails", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const sql = yield* SqlClient.SqlClient
        yield* arrange()
        yield* sql`CREATE TRIGGER reject_attempt BEFORE INSERT ON kernel_resume_attempts
        BEGIN SELECT RAISE(ABORT, 'injected'); END`
        const failed = yield* store
          .claimResume({ owningHostId: "h", workerId: "w", now, leaseDurationMs: 60_000 })
          .pipe(Effect.result)
        return { failed, request: yield* store.readResumeRequest("q") }
      }),
    )
    expect(result.failed._tag).toBe("Failure")
    expect(result.request).toMatchObject({ state: "ready", attempt: 0 })
  })

  test("accepts exact multibyte JSON bound and rejects max plus one", async () => {
    const exact = "é".repeat((MAX_CUSTODY_JSON_BYTES - 2) / 2)
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
        const add = (id: string, prompt: string) =>
          store
            .registerResumeRequest({
              requestId: id,
              sessionId: "s",
              owningHostId: "h",
              prompt,
              promptText: JSON.stringify(prompt),
              promptSha256: createHash("sha256").update(JSON.stringify(prompt)).digest("hex"),
              outputContract: null,
              outputContractVersion: null,
              maxAttempts: 1,
              runAt: now,
              createdAt: now,
            })
            .pipe(Effect.result)
        return { exact: yield* add("exact", exact), large: yield* add("large", `${exact}a`) }
      }),
    )
    expect(result.exact._tag).toBe("Success")
    expect(result.large).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreInputError" },
    })
  })

  test("rolls back every cleanup completion row when outcome persistence fails", async () => {
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
        const claim = yield* store.claimCleanup({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        if (!claim) return yield* Effect.die(new Error("cleanup"))
        yield* sql`CREATE TRIGGER reject_cleanup_outcome BEFORE INSERT ON kernel_cleanup_outcomes
        BEGIN SELECT RAISE(ABORT, 'injected'); END`
        const failed = yield* store
          .completeCleanup({
            cleanupId: "c",
            attempt: 1,
            owningHostId: "h",
            workerId: "w",
            claimToken: claim.claimToken,
            expectedLeaseUntil: claim.leaseUntil,
            now: new Date(now.getTime() + 1),
            outcomeId: "o",
            disposition: "completed",
            outcomeVersion: 1,
            outcome: {},
          })
          .pipe(Effect.result)
        const attempt = yield* sql`SELECT state FROM kernel_cleanup_attempts WHERE cleanup_id = 'c'`
        const request = yield* sql`SELECT state FROM kernel_cleanup_requests WHERE cleanup_id = 'c'`
        const resource =
          yield* sql`SELECT state FROM kernel_working_resources WHERE resource_id = 'r'`
        return { attempt, failed, request, resource }
      }),
    )
    expect(result.failed._tag).toBe("Failure")
    expect(result.attempt).toEqual([{ state: "leased" }])
    expect(result.request).toEqual([{ state: "leased" }])
    expect(result.resource).toEqual([{ state: "cleanup_leased" }])
  })
})
