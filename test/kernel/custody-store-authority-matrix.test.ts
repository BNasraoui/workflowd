import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody common authority matrix", () => {
  for (const operation of [
    "heartbeat",
    "sent",
    "checkpoint",
    "complete",
    "fail",
    "cancel",
    "release",
  ] as const) {
    test(`${operation} applies every resume authority field`, async () => {
      const tags = await Promise.all(
        ["host", "worker", "attempt", "token", "deadline", "expiry"].map((field) =>
          runSessionKernel(
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
              const claim = yield* store.claimResume({
                owningHostId: "h",
                workerId: "w",
                now,
                leaseDurationMs: 60_000,
              })
              if (!claim) return yield* Effect.die(new Error("claim"))
              const base = {
                requestId: "q",
                attempt: 1,
                owningHostId: "h",
                workerId: "w",
                claimToken: claim.claimToken,
                expectedLeaseUntil: claim.leaseUntil,
                now,
              }
              const input =
                field === "host"
                  ? { ...base, owningHostId: "other" }
                  : field === "worker"
                    ? { ...base, workerId: "other" }
                    : field === "attempt"
                      ? { ...base, attempt: 2 }
                      : field === "token"
                        ? { ...base, claimToken: "other" }
                        : field === "deadline"
                          ? {
                              ...base,
                              expectedLeaseUntil: new Date(claim.leaseUntil.getTime() + 1),
                            }
                          : { ...base, now: claim.leaseUntil }
              const effect =
                operation === "heartbeat"
                  ? store.heartbeatResume({ ...input, leaseDurationMs: 1 })
                  : operation === "sent"
                    ? store.markResumeSent(input)
                    : operation === "checkpoint"
                      ? store.checkpointResume({
                          ...input,
                          checkpointId: "cp",
                          checkpointVersion: 1,
                          checkpoint: {},
                        })
                      : operation === "complete"
                        ? store.completeResume({
                            ...input,
                            resultId: "result",
                            resultVersion: 1,
                            result: {},
                          })
                        : operation === "fail"
                          ? store.failResume(input)
                          : operation === "cancel"
                            ? store.cancelResume(input)
                            : store.releaseResume({ ...input, runAt: now })
              const result = yield* effect.pipe(Effect.either)
              return result._tag === "Left" && result.left._tag
            }),
          ),
        ),
      )
      expect(tags).toEqual(Array.from({ length: 6 }, () => "KernelSessionStoreAuthorityError"))
    })
  }

  for (const operation of ["heartbeat", "complete"] as const) {
    test(`${operation} applies every cleanup authority field`, async () => {
      const tags = await Promise.all(
        ["host", "worker", "attempt", "token", "deadline", "expiry"].map((field) =>
          runSessionKernel(
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
              const claim = yield* store.claimCleanup({
                owningHostId: "h",
                workerId: "w",
                now,
                leaseDurationMs: 60_000,
              })
              if (!claim) return yield* Effect.die(new Error("claim"))
              const base = {
                cleanupId: "c",
                attempt: 1,
                owningHostId: "h",
                workerId: "w",
                claimToken: claim.claimToken,
                expectedLeaseUntil: claim.leaseUntil,
                now,
              }
              const input =
                field === "host"
                  ? { ...base, owningHostId: "other" }
                  : field === "worker"
                    ? { ...base, workerId: "other" }
                    : field === "attempt"
                      ? { ...base, attempt: 2 }
                      : field === "token"
                        ? { ...base, claimToken: "other" }
                        : field === "deadline"
                          ? {
                              ...base,
                              expectedLeaseUntil: new Date(claim.leaseUntil.getTime() + 1),
                            }
                          : { ...base, now: claim.leaseUntil }
              const result =
                operation === "heartbeat"
                  ? yield* store
                      .heartbeatCleanup({ ...input, leaseDurationMs: 1 })
                      .pipe(Effect.either)
                  : yield* store
                      .completeCleanup({
                        ...input,
                        outcomeId: "outcome",
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
  }
})
