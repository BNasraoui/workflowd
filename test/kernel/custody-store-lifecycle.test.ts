import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")
const prompt = { task: "continue" } as const
const promptText = JSON.stringify(prompt)
const promptSha256 = createHash("sha256").update(promptText).digest("hex")

describe("kernel custody lifecycle", () => {
  test("registers explicit custody and moves expired sent work to observation", async () => {
    const result = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* store.registerResource({
          resourceId: "resource",
          owningHostId: "host-a",
          absolutePath: "/srv/work/item",
          kind: "worktree",
          createdAt: now,
        })
        yield* store.registerSession({
          sessionId: "session",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "provider",
          serverId: "server",
          owningHostId: "host-a",
          endpointAlias: "private",
          endpointIdentity: "unix:/run/opencode.sock",
          nativeSessionId: "native",
          resourceId: "resource",
          createdAt: now,
        })
        yield* store.registerResumeRequest({
          requestId: "request",
          sessionId: "session",
          owningHostId: "host-a",
          prompt,
          promptText,
          promptSha256,
          outputContract: "answer",
          outputContractVersion: 1,
          maxAttempts: 3,
          runAt: now,
          createdAt: now,
        })
        const claim = yield* store.claimResume({
          owningHostId: "host-a",
          workerId: "worker",
          now,
          leaseDurationMs: 1,
        })
        if (claim === null) return yield* Effect.die(new Error("expected claim"))
        yield* store.markResumeSent({ ...claim, expectedLeaseUntil: claim.leaseUntil, now })
        const recovered = yield* store.recoverExpiredResume({
          owningHostId: "host-a",
          now: claim.leaseUntil,
        })
        return { claim, recovered, request: yield* store.readResumeRequest("request") }
      }),
    )

    expect(result.claim).toMatchObject({
      requestId: "request",
      owningHostId: "host-a",
      attempt: 1,
      outputContract: "answer",
      outputContractVersion: 1,
    })
    expect(result.recovered).toBe(1)
    expect(result.request).toMatchObject({ state: "observation_required", attempt: 1 })
  })

  test("rejects relative and lexically non-normalized paths without filesystem access", async () => {
    const tags = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        return yield* Effect.forEach(
          ["relative/path", "/srv/../work", "/srv//work", "/srv/work/"],
          (absolutePath, index) =>
            store
              .registerResource({
                resourceId: `r-${index}`,
                owningHostId: "host",
                absolutePath,
                kind: "workspace",
                createdAt: now,
              })
              .pipe(
                Effect.result,
                Effect.map((result) => result._tag === "Failure" && result.failure._tag),
              ),
        )
      }),
    )

    expect(tags).toEqual(Array.from({ length: 4 }, () => "KernelSessionStoreInputError"))
  })
})
