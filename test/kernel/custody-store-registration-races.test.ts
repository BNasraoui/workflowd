import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { removeDatabase } from "./job-store-harness"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody registration races", () => {
  test("concurrent resource registration has one durable identity", async () => {
    const file = `${process.cwd()}/resource-race-${crypto.randomUUID()}.sqlite`
    try {
      await runSessionKernel(file, Effect.void)
      const register = (path: string) =>
        runSessionKernel(
          file,
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            return yield* store
              .registerResource({
                resourceId: "r",
                owningHostId: "h",
                absolutePath: path,
                kind: "workspace",
                createdAt: now,
              })
              .pipe(Effect.result)
          }),
        )
      const results = await Promise.all([register("/one"), register("/two")])
      expect(results.filter((x) => x._tag === "Success")).toHaveLength(1)
      expect(results.filter((x) => x._tag === "Failure")).toHaveLength(1)
      expect(results.find((x) => x._tag === "Failure")).toMatchObject({
        left: { _tag: "KernelSessionStoreConflictError", record: "resource", key: "r" },
      })
    } finally {
      await removeDatabase(file)
    }
  })

  test("concurrent session registration has one winner and one typed conflict", async () => {
    const file = `${process.cwd()}/session-race-${crypto.randomUUID()}.sqlite`
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
        }),
      )
      const register = (sessionId: string) =>
        runSessionKernel(
          file,
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            return yield* store
              .registerSession({
                sessionId,
                providerKind: "opencode",
                providerVersion: 1,
                providerId: "p",
                serverId: "server",
                owningHostId: "h",
                endpointAlias: "a",
                endpointIdentity: "e",
                nativeSessionId: "native",
                resourceId: "r",
                createdAt: now,
              })
              .pipe(Effect.result)
          }),
        )
      const results = await Promise.all([register("s1"), register("s2")])
      expect(results.filter((x) => x._tag === "Success")).toHaveLength(1)
      expect(results.find((x) => x._tag === "Failure")).toMatchObject({
        left: { _tag: "KernelSessionStoreConflictError", record: "session" },
      })
    } finally {
      await removeDatabase(file)
    }
  })

  test("active native identity is unique and cleanup blocks replacement registration", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* store.registerResource({
          resourceId: "r",
          owningHostId: "h",
          absolutePath: "/work",
          kind: "worktree",
          createdAt: now,
        })
        const session = (sessionId: string) =>
          store.registerSession({
            sessionId,
            providerKind: "opencode",
            providerVersion: 1,
            providerId: "p",
            serverId: "server",
            owningHostId: "h",
            endpointAlias: "a",
            endpointIdentity: "e",
            nativeSessionId: "native",
            resourceId: "r",
            createdAt: now,
          })
        yield* session("s1")
        const duplicateNative = yield* session("s2").pipe(Effect.result)
        yield* store.requestCleanup({
          cleanupId: "c",
          resourceId: "r",
          owningHostId: "h",
          reason: "done",
          maxAttempts: 1,
          runAt: now,
          createdAt: now,
        })
        const replacement = yield* store
          .registerSession({
            sessionId: "s3",
            providerKind: "codex",
            providerVersion: 1,
            providerId: "other",
            serverId: "server",
            owningHostId: "h",
            endpointAlias: "a",
            endpointIdentity: "other",
            nativeSessionId: "other",
            resourceId: "r",
            createdAt: now,
          })
          .pipe(Effect.result)
        return { duplicateNative, replacement }
      }),
    )
    expect(result.duplicateNative._tag).toBe("Failure")
    expect(result.replacement).toMatchObject({
      _tag: "Failure",
      left: { _tag: "KernelSessionStoreConflictError" },
    })
  })
})
