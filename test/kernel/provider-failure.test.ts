import { expect, test } from "bun:test"
import { providerFailure, providerRetryDelay } from "../../src/provider-failure"
import { CodexRetryTurn } from "../../src/kernel/codex-retry"

test("structured Codex failures take precedence over HTTP fallback", () => {
  expect(providerFailure("HTTP 429", "serverOverloaded")?.reason).toBe("model_at_capacity")
  expect(
    providerFailure("Please retry", { httpConnectionFailed: { httpStatusCode: 429 } })?.reason,
  ).toBe("provider_rate_limited")
  expect(providerFailure("HTTP 429", "contextWindowExceeded")).toBeUndefined()
  expect(providerFailure("HTTP 503: model at capacity")?.reason).toBe("model_at_capacity")
  expect(providerFailure("unexpected status 429 Too Many Requests")?.reason).toBe(
    "provider_rate_limited",
  )
})

for (const message of [
  "Opened PR #429",
  "line 429",
  "request req-429-abc",
  "gh: API rate limit exceeded",
  "Rate limit exceeded",
  "server_overloaded",
  "Selected model is at capacity.",
  null,
  undefined,
])
  test(`non-provider text does not classify: ${message}`, () => {
    expect(providerFailure(message)).toBeUndefined()
  })

test("provider messages redact credentials and URLs before byte truncation", () => {
  expect(providerFailure(null, "serverOverloaded")?.message).toBe("model_at_capacity")
  const failure = providerFailure(
    "Selected model is at capacity.\nAuthorization: Bearer sk-private-token\nhttps://api.example.test/private?token=secret",
    "serverOverloaded",
  )
  expect(failure?.message).toContain("Selected model is at capacity")
  expect(failure?.message).not.toContain("sk-private")
  expect(failure?.message).not.toContain("https://")
  const oversized = providerFailure("😀".repeat(1000), "serverOverloaded")
  expect(Buffer.byteLength(JSON.stringify(oversized?.message)) - 2).toBeLessThanOrEqual(512)
})

test("two retries use full jitter over ten and twenty second windows", () => {
  expect(providerRetryDelay(0, () => 0)).toBe(0)
  expect(providerRetryDelay(0, () => 0.5)).toBe(5000)
  expect(providerRetryDelay(1, () => 0.999)).toBe(19980)
  expect(providerRetryDelay(2)).toBeUndefined()
})

test("chunked Codex errors retry only with positive evidence of a safe turn", () => {
  const chunk = (turn: CodexRetryTurn, value: unknown) =>
    turn.chunk(new TextEncoder().encode(JSON.stringify(value) + "\n"))
  const ready = () => {
    const turn = new CodexRetryTurn()
    chunk(turn, { type: "thread.started", thread_id: "one" })
    chunk(turn, {
      type: "turn.failed",
      error: { message: "Retry later", codexErrorInfo: "serverOverloaded" },
    })
    return turn
  }
  expect(ready().retryDelay(0)).toBeLessThan(10000)
  expect(ready().retryDelay(2)).toBeUndefined()
  for (const type of [
    "command_execution",
    "mcp_tool_call",
    "file_change",
    "web_search",
    "todo_list",
    "unknown",
  ]) {
    const turn = ready()
    chunk(turn, { type: "item.started", item: { type } })
    expect(turn.retryDelay(0)).toBeUndefined()
  }
  for (const value of [
    { type: "item.started" },
    { type: "unknown" },
    { type: "error", message: "Unauthorized" },
  ]) {
    const turn = ready()
    chunk(turn, value)
    expect(turn.retryDelay(0)).toBeUndefined()
  }
  const malformed = ready()
  malformed.chunk(new TextEncoder().encode("not json\n"))
  expect(malformed.retryDelay(0)).toBeUndefined()
  const oversized = ready()
  oversized.chunk(new TextEncoder().encode("x".repeat(65537)))
  expect(oversized.retryDelay(0)).toBeUndefined()
  const partial = new CodexRetryTurn()
  chunk(partial, { type: "thread.started", thread_id: "one" })
  partial.chunk(new TextEncoder().encode('{"type":"error","message":"HTTP 429 Rate '))
  partial.chunk(new TextEncoder().encode('limit exceeded"}'))
  expect(partial.retryDelay(0)).toBeLessThan(10000)
})
