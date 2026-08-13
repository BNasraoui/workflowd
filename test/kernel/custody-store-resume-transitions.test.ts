import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import { KernelSessionStore, type ResumeClaim } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")
const arrangeClaim = () =>
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
      maxAttempts: 3,
      runAt: now,
      createdAt: now,
    })
    const claim = yield* store.claimResume({
      owningHostId: "h",
      workerId: "w",
      now,
      leaseDurationMs: 60_000,
    })
    if (claim === null) return yield* Effect.die(new Error("expected claim"))
    return claim
  })
const authority = (claim: ResumeClaim, at = new Date(now.getTime() + 1)) => ({
  requestId: claim.requestId,
  attempt: claim.attempt,
  owningHostId: claim.owningHostId,
  workerId: claim.workerId,
  claimToken: claim.claimToken,
  expectedLeaseUntil: claim.leaseUntil,
  now: at,
})

describe("resume authority transitions", () => {
  test("supports heartbeat, checkpoint, release, fail, cancel, and complete with exact authority", async () => {
    const statuses = await Promise.all(
      ["heartbeat", "checkpoint", "release", "fail", "cancel", "complete"].map((kind) =>
        runSessionKernel(
          ":memory:",
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            const claim = yield* arrangeClaim()
            if (kind === "heartbeat")
              return (yield* store.heartbeatResume({
                ...authority(claim),
                leaseDurationMs: 120_000,
              })).leaseUntil
            if (kind === "checkpoint")
              return (yield* store.checkpointResume({
                ...authority(claim),
                checkpointId: "cp",
                checkpointVersion: 1,
                checkpoint: { n: 1 },
              })).status
            if (kind === "release") {
              yield* store.releaseResume({
                ...authority(claim),
                runAt: new Date(now.getTime() + 10),
              })
              return "released"
            }
            if (kind === "fail") {
              yield* store.failResume(authority(claim))
              return "failed"
            }
            if (kind === "cancel") {
              yield* store.cancelResume(authority(claim))
              return "cancelled"
            }
            return (yield* store.completeResume({
              ...authority(claim),
              resultId: "result",
              resultVersion: 1,
              result: { ok: true },
            })).status
          }),
        ),
      ),
    )

    expect(statuses).toEqual([
      new Date("2026-08-12T10:02:00.001Z"),
      "created",
      "released",
      "failed",
      "cancelled",
      "completed",
    ])
  })

  test("rejects every authority dimension and exact expiry without mutation", async () => {
    const tags = await Promise.all(
      ["host", "worker", "attempt", "token", "deadline", "expiry"].map((dimension) =>
        runSessionKernel(
          ":memory:",
          Effect.gen(function* () {
            const store = yield* KernelSessionStore
            const claim = yield* arrangeClaim()
            const base = authority(claim)
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
            const failed = yield* store.failResume(changed).pipe(Effect.either)
            return {
              tag: failed._tag === "Left" && failed.left._tag,
              request: yield* store.readResumeRequest("q"),
            }
          }),
        ),
      ),
    )
    expect(tags.map(({ tag }) => tag)).toEqual(
      Array.from({ length: 6 }, () => "KernelSessionStoreAuthorityError"),
    )
    expect(tags.every(({ request }) => request?.state === "leased")).toBe(true)
  })

  test("reclaims an unsent expired lease with a fresh token and attempt", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const first = yield* arrangeClaim()
        const second = yield* store.claimResume({
          owningHostId: "h",
          workerId: "new",
          now: first.leaseUntil,
          leaseDurationMs: 60_000,
        })
        const sql = yield* SqlClient.SqlClient
        return {
          attempts: yield* sql`SELECT attempt, state FROM kernel_resume_attempts
          WHERE request_id = 'q' ORDER BY attempt`,
          first,
          second,
        }
      }),
    )
    expect(result.second).toMatchObject({ attempt: 2, workerId: "new" })
    expect(result.second?.claimToken).not.toBe(result.first.claimToken)
    expect(result.attempts).toEqual([
      { attempt: 1, state: "released" },
      { attempt: 2, state: "leased" },
    ])
  })

  test("replays exact stored completion after expiry but rejects changed or stale identity", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const claim = yield* arrangeClaim()
        const completion = {
          ...authority(claim),
          resultId: "result",
          resultVersion: 1,
          result: { value: 1 },
        }
        yield* store.completeResume(completion)
        const afterExpiry = { ...completion, now: claim.leaseUntil }
        const exact = yield* store.completeResume(afterExpiry).pipe(Effect.either)
        const changed = yield* store
          .completeResume({ ...afterExpiry, result: { value: 2 } })
          .pipe(Effect.either)
        const stale = yield* store
          .completeResume({ ...afterExpiry, claimToken: "stale" })
          .pipe(Effect.either)
        return { changed, exact, stale }
      }),
    )
    expect(result.exact).toMatchObject({ _tag: "Right", right: { status: "duplicate" } })
    expect(result.changed).toMatchObject({
      _tag: "Left",
      left: { _tag: "KernelSessionStoreConflictError" },
    })
    expect(result.stale).toMatchObject({
      _tag: "Left",
      left: { _tag: "KernelSessionStoreAuthorityError" },
    })
  })

  test("release after sent never makes the request ready for resend", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        const claim = yield* arrangeClaim()
        const auth = authority(claim)
        yield* store.markResumeSent(auth)
        const release = yield* store
          .releaseResume({ ...auth, runAt: new Date(now.getTime() + 10) })
          .pipe(Effect.either)
        const request = yield* store.readResumeRequest("q")
        const resend = yield* store.claimResume({
          owningHostId: "h",
          workerId: "new",
          now: new Date(now.getTime() + 10),
          leaseDurationMs: 60_000,
        })
        return { release, request, resend }
      }),
    )
    expect(result.resend).toBeNull()
    expect(result.request).toMatchObject({ state: "observation_required" })
    expect(result.release._tag).toBe("Right")
  })
})
