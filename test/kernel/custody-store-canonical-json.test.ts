import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

const now = new Date("2026-08-12T10:00:00.000Z")

describe("custody canonical JSON", () => {
  test("sorts object keys by deterministic code-unit order", async () => {
    const text = '{"Z":1,"a":2}'
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
        return yield* store
          .registerResumeRequest({
            requestId: "q",
            sessionId: "s",
            owningHostId: "h",
            prompt: { a: 2, Z: 1 },
            promptText: text,
            promptSha256: createHash("sha256").update(text).digest("hex"),
            outputContract: null,
            outputContractVersion: null,
            maxAttempts: 1,
            runAt: now,
            createdAt: now,
          })
          .pipe(Effect.either)
      }),
    )
    expect(result._tag).toBe("Right")
  })
})
