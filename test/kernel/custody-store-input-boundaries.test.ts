import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelSessionStore, MAX_CUSTODY_PATH_BYTES } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

describe("custody input boundaries", () => {
  test("rejects invalid dates as typed input errors", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        return yield* store
          .registerResource({
            resourceId: "r",
            owningHostId: "h",
            absolutePath: "/work",
            kind: "workspace",
            createdAt: new Date(Number.NaN),
          })
          .pipe(Effect.result)
      }),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreInputError" },
    })
  })

  test("rejects an oversized path at the Effect boundary", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        return yield* store
          .registerResource({
            resourceId: "r",
            owningHostId: "h",
            absolutePath: `/${"a".repeat(MAX_CUSTODY_PATH_BYTES)}`,
            kind: "workspace",
            createdAt: new Date("2026-08-12T10:00:00.000Z"),
          })
          .pipe(Effect.result)
      }),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreInputError" },
    })
  })

  test("rejects invalid claim and authority dates as typed input errors", async () => {
    const results = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const at = new Date("2026-08-12T10:00:00.000Z")
        yield* store.registerResource({
          resourceId: "r",
          owningHostId: "h",
          absolutePath: "/work",
          kind: "workspace",
          createdAt: at,
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
          createdAt: at,
        })
        const text = "{}"
        yield* store.registerResumeRequest({
          requestId: "q",
          sessionId: "s",
          owningHostId: "h",
          prompt: {},
          promptText: text,
          promptSha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          outputContract: null,
          outputContractVersion: null,
          maxAttempts: 2,
          runAt: at,
          createdAt: at,
        })
        const invalidClaim = yield* store
          .claimResume({
            owningHostId: "h",
            workerId: "w",
            now: new Date(Number.NaN),
            leaseDurationMs: 1,
          })
          .pipe(Effect.result)
        const claim = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now: at,
          leaseDurationMs: 60_000,
        })
        if (!claim) return yield* Effect.die(new Error("claim"))
        const invalidAuthority = yield* store
          .failResume({
            requestId: "q",
            attempt: 1,
            owningHostId: "h",
            workerId: "w",
            claimToken: claim.claimToken,
            expectedLeaseUntil: new Date(Number.NaN),
            now: at,
          })
          .pipe(Effect.result)
        return [invalidClaim, invalidAuthority]
      }),
    )
    expect(
      results.map((result) => (result._tag === "Failure" ? result.failure._tag : "Success")),
    ).toEqual(["KernelSessionStoreInputError", "KernelSessionStoreInputError"])
  })

  test("rejects lease deadline overflow as a typed input error", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const at = new Date("2026-08-12T10:00:00.000Z")
        yield* store.registerResource({
          resourceId: "r",
          owningHostId: "h",
          absolutePath: "/work",
          kind: "workspace",
          createdAt: at,
        })
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "done",
          maxAttempts: 1,
          runAt: at,
          createdAt: at,
        })
        return yield* store
          .claimCleanup({
            owningHostId: "h",
            workerId: "w",
            now: at,
            leaseDurationMs: Number.MAX_SAFE_INTEGER,
          })
          .pipe(Effect.result)
      }),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelSessionStoreInputError" },
    })
  })
})
