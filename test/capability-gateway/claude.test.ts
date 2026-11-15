import { expect, test } from "bun:test"
import { claudeRequest, type ClaudeRequest } from "../../src/capability-gateway/claude"

const native = JSON.stringify({ model: "claude-opus-4-6" })
const session = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const headers = {
  authorization: "Bearer gateway-sentinel",
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219, oauth-2025-04-20",
  "user-agent": "claude-cli/2.1.301",
  "x-claude-code-session-id": session,
}

let credentialReads = 0
const call = async (extra: Record<string, string | undefined> = {}, body = native) => {
  const sent: Array<{ url: string; input: ClaudeRequest }> = []
  const request = new Request("http://capability.invalid/v1/messages", {
    method: "POST",
    headers: Object.fromEntries(
      Object.entries({ ...headers, ...extra }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    body,
  })
  const result = await claudeRequest(
    request,
    "/v1/messages?beta=true",
    "claude-opus-4-6",
    async () => {
      credentialReads++
      return "provider-access"
    },
    new AbortController().signal,
    async (url, input) => {
      sent.push({ url, input })
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  )
  return { result, sent }
}

test("Claude requests forward only bounded native headers and replace authorization", async () => {
  const { sent } = await call()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true")
  expect(Object.fromEntries(sent[0]!.input.headers)).toEqual({
    "anthropic-beta": "claude-code-20250219, oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "accept-encoding": "identity",
    authorization: "Bearer provider-access",
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.301",
    "x-claude-code-session-id": session,
  })
})

test.each([
  ["host header", { host: "capability.invalid" }],
  ["unlisted header", { "x-api-key": "direct" }],
  ["foreign session", { "x-claude-code-session-id": "other-session" }],
  ["oversized value", { "user-agent": "x".repeat(2049) }],
  [
    "oversized total",
    Object.fromEntries(
      ["arch", "lang", "os", "runtime", "runtime-version"].map((name) => [
        `x-stainless-${name}`,
        "y".repeat(2000),
      ]),
    ),
  ],
  ["non-JSON content", { "content-type": "text/plain" }],
  ["wrong API version", { "anthropic-version": "2024-01-01" }],
  ["missing OAuth beta", { "anthropic-beta": "claude-code-20250219" }],
] as const)("Claude requests refuse a %s before reading credentials", async (_name, extra) => {
  credentialReads = 0
  await expect(call(extra)).rejects.toThrow("request refused")
  expect(credentialReads).toBe(0)
})

test("Claude requests refuse another model", async () => {
  credentialReads = 0
  await expect(call({}, JSON.stringify({ model: "claude-haiku-4-5" }))).rejects.toThrow(
    "request refused",
  )
  expect(credentialReads).toBe(0)
})
