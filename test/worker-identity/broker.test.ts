import { expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { makeTokenBroker } from "../../src/worker-identity/broker"
const policy = {
  repository: "o/r",
  installationId: 1,
  permissions: { contents: "read" as const, actions: "read" as const },
}
test("mints repository/permission-scoped tokens, coalesces and refreshes before expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0
      const broker = yield* makeTokenBroker(async (input) => {
        calls++
        expect(input).toEqual({
          installation_id: 1,
          repositories: ["r"],
          permissions: policy.permissions,
        })
        return {
          token: "secret-app-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }
      })
      const results = yield* Effect.all([broker(policy), broker(policy)], {
        concurrency: "unbounded",
      })
      expect(calls).toBe(1)
      expect(Redacted.value(results[0].token)).toBe("secret-app-token")
      expect(JSON.stringify(results[0])).not.toContain("secret-app-token")
    }),
  ))
test("broker does not expose credential-bearing SDK errors", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const broker = yield* makeTokenBroker(async () => {
        throw new Error("authorization: secret-app-token")
      })
      const result = yield* Effect.result(broker(policy))
      expect(JSON.stringify(result)).not.toContain("secret-app-token")
      expect(result._tag).toBe("Failure")
    }),
  ))
