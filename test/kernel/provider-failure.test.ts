import { expect, test } from "bun:test"
import { providerFailure, providerRetryDelay } from "../../src/provider-failure"
import { CodexRetryTurn } from "../../src/kernel/codex-retry"

test("only explicit capacity and rate failures qualify for bounded retries", () => {
  expect(
    providerFailure("Selected model is at capacity. Please try a different model.")?.reason,
  ).toBe("model_at_capacity")
  expect(providerFailure("server_overloaded")?.reason).toBe("model_at_capacity")
  for (const message of [
    "Rate limit exceeded",
    "rate_limit_exceeded",
    "HTTP 429",
    "Too many requests",
  ])
    expect(providerFailure(message)?.reason).toBe("provider_rate_limited")
  for (const message of [null, undefined, "Unauthorized", "thread not found", "insufficient quota"])
    expect(providerFailure(message)).toBeUndefined()
  expect([0, 1, 2].map(providerRetryDelay)).toEqual([1000, 2000, undefined])
})

test("chunked Codex errors retry only with positive evidence of a safe turn", () => {
  const chunk = (turn: CodexRetryTurn, value: unknown) =>
    turn.chunk(new TextEncoder().encode(JSON.stringify(value) + "\n"))
  const ready = () => {
    const turn = new CodexRetryTurn()
    chunk(turn, { type: "thread.started", thread_id: "one" })
    chunk(turn, { type: "turn.failed", error: { message: "Rate limit exceeded" } })
    return turn
  }
  expect(ready().retryDelay(0)).toBe(1000)
  expect(ready().retryDelay(2)).toBeUndefined()
  for (const type of [
    "command_execution",
    "mcp_tool_call",
    "file_change",
    "web_search",
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
  partial.chunk(new TextEncoder().encode('{"type":"error","message":"Rate '))
  partial.chunk(new TextEncoder().encode('limit exceeded"}'))
  expect(partial.retryDelay(0)).toBe(1000)
})
