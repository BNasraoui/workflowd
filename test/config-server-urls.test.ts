import { expect, test } from "bun:test"
import { inspect } from "node:util"
import { Effect, Logger } from "effect"
import { loadConfig } from "../src/config"
import { requiredEnvironment } from "./helpers/config"

for (const name of [
  "OPENCODE_SERVER_URL",
  "WORKFLOWD_REVIEW_OPENCODE_URL",
  "WORKFLOWD_OPENCODE_ATTACH_URL",
  "WORKFLOWD_NATS_SERVERS",
]) {
  const protocol = name === "WORKFLOWD_NATS_SERVERS" ? "nats" : "https"
  test.each([
    "url-secret@example.test:4096",
    "user:url-secret@example.test:4096",
    "example.test:4096?token=url-secret",
    "example.test:4096#url-secret",
    "user:url-secret@invalid host",
  ])(`${name} rejects unsafe URLs without exposing them: %s`, async (authority) => {
    const value = `${protocol}://${authority}`
    const logs: unknown[] = []
    const result = await Effect.runPromise(
      Effect.tryPromise(() =>
        loadConfig({
          ...requiredEnvironment,
          WORKFLOWD_REMOTE_COORDINATOR_ENABLED: "true",
          WORKFLOWD_NATS_SERVERS: "nats://example.test:4222",
          WORKFLOWD_NATS_TOKEN: "fixture-token",
          [name]: value,
        }),
      ).pipe(
        Effect.tapError((error) => Effect.logError("Configuration failed", error)),
        Effect.result,
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected configuration rejection")
    const cause = result.failure.cause
    if (!(cause instanceof Error)) throw new Error("Expected a configuration error")
    expect(cause.message).toContain(name)
    expect(logs).toHaveLength(1)
    for (const rendered of [
      cause.message,
      inspect(result.failure, { depth: null }),
      inspect(logs, { depth: null }),
      JSON.stringify(logs),
    ]) {
      expect(rendered).not.toContain(value)
      expect(rendered).not.toContain("url-secret")
    }
  })
}

test("OpenCode base URLs retain HTTP(S), paths, and trailing-slash normalization", async () => {
  for (const protocol of ["http", "https"]) {
    const config = await loadConfig({
      ...requiredEnvironment,
      OPENCODE_SERVER_URL: `${protocol}://example.test:4096/opencode/`,
    })
    expect(config.openCode.baseUrl).toBe(`${protocol}://example.test:4096/opencode`)
  }
})
