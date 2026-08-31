import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody session states", () => {
  test("returns a woken session to ready under its next generation", async () => {
    const states = await runSessionKernel(
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
        const ready = yield* store.readSession("s")
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
        const claim = yield* store.claimResume({
          owningHostId: "h",
          workerId: "w",
          now,
          leaseDurationMs: 60_000,
        })
        if (!claim) return yield* Effect.die(new Error("claim"))
        const active = yield* store.readSession("s")
        yield* store.completeResume({
          requestId: "q",
          attempt: 1,
          owningHostId: "h",
          workerId: "w",
          claimToken: claim.claimToken,
          expectedLeaseUntil: claim.leaseUntil,
          now,
          resultId: "result",
          resultVersion: 1,
          result: {},
        })
        return { active, completed: yield* store.readSession("s"), ready }
      }),
    )
    expect(states.ready).toMatchObject({ state: "ready", revision: 1 })
    expect(states.active).toMatchObject({ state: "active" })
    // A delivered wake advances the custody generation but leaves the
    // session held and wakeable: a parent can be woken again and again.
    expect(states.completed).toMatchObject({ state: "ready", revision: 3 })
  })

  test("normalizes session after release, fail, cancel, and final exhaustion", async () => {
    const states = await Promise.all(
      ["release", "fail", "cancel", "exhaust"].map((kind) =>
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
              maxAttempts: kind === "exhaust" ? 1 : 2,
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
            const auth = {
              requestId: "q",
              attempt: 1,
              owningHostId: "h",
              workerId: "w",
              claimToken: claim.claimToken,
              expectedLeaseUntil: claim.leaseUntil,
              now,
            }
            if (kind === "release")
              yield* store.releaseResume({ ...auth, runAt: new Date(now.getTime() + 1) })
            if (kind === "fail") yield* store.failResume(auth)
            if (kind === "cancel") yield* store.cancelResume(auth)
            if (kind === "exhaust")
              yield* store.claimResume({
                owningHostId: "h",
                workerId: "new",
                now: claim.leaseUntil,
                leaseDurationMs: 1,
              })
            return (yield* store.readSession("s"))?.state
          }),
        ),
      ),
    )
    expect(states).toEqual(["ready", "completed", "completed", "operator_required"])
  })
})
