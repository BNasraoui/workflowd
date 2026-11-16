import { expect, test } from "bun:test"
import { claudeRequest, type ClaudeRequest } from "../../src/capability-gateway/claude"

const native = JSON.stringify({ model: "claude-opus-4-6", max_tokens: 1000 })
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
    64000,
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

/**
 * Sends a messages call (or the call of `path`) whose upstream answers `answer`, reads the answer
 * that the client gets to its end, and gives its text, the usage the gateway read and the
 * reservation it was sent with.
 */
const metered = async (answer: Response, path = "/v1/messages") => {
  const reservations: number[] = []
  const result = await claudeRequest(
    new Request(`http://capability.invalid${path}`, {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(headers).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      body: native,
    }),
    path,
    "claude-opus-4-6",
    async () => "provider-access",
    new AbortController().signal,
    async (_url, _input, reservation) => {
      reservations.push(reservation)
      return answer
    },
    64000,
  )
  const text = await result.response.text()
  return { text, usage: result.usage(), reservations }
}

/** `parts` as a stream of their bytes, one chunk each. */
const chunked = (parts: ReadonlyArray<string>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
      controller.close()
    },
  })
const eventStream = (body: BodyInit) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } })

test("the usage of an event stream is read across chunks, with CRLF line ends, and past an event above the bound", async () => {
  const start = `event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":2,"output_tokens":1}}}\r\n\r\n`
  const long = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${"y".repeat(70000)}"}}\n\n`
  const end = `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n`
  const parts = [start.slice(0, 30), start.slice(30), long.slice(0, 40000), long.slice(40000), end]
  const read = await metered(eventStream(chunked(parts)))
  // The same answer as one chunk is read the same.
  expect((await metered(eventStream(parts.join("")))).usage?.outputTokens).toBe(12)
  expect(read.text).toBe(parts.join(""))
  expect(read.reservations).toEqual([1000])
  expect(read.usage).toEqual({
    inputTokens: 5,
    outputTokens: 12,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2,
  })
  // A message_delta inside an event above the bound is not read: the call reports no output.
  const hidden = `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3},"pad":"${"z".repeat(70000)}"}\n\n`
  expect(
    (await metered(eventStream(chunked([hidden.slice(0, 50000), hidden.slice(50000)])))).usage,
  ).toEqual({
    inputTokens: 0,
    outputTokens: undefined,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
  // A usage that is not an object makes the usage of the call unknown.
  const bare = `event: message_delta\ndata: {"type":"message_delta","usage":7}\n\n`
  expect((await metered(eventStream(bare))).usage).toBeUndefined()
})

test("an answer of another type, or a JSON answer above the bound, reports no usage", async () => {
  const json = (body: string) =>
    new Response(body, { headers: { "content-type": "application/json" } })
  const usage = '{"usage":{"input_tokens":1,"output_tokens":2}}'
  expect((await metered(json(usage))).usage).toEqual({
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
  const large = `{"pad":"${"a".repeat(4 * 1048576)}","usage":{"input_tokens":1,"output_tokens":2}}`
  expect((await metered(json(large))).usage?.outputTokens).toBeUndefined()
  const text = new Response(usage, { headers: { "content-type": "text/plain" } })
  expect((await metered(text)).usage).toBeUndefined()
})

test("a count of tokens reserves no output and reports no usage; an error answer reports no output", async () => {
  const counted = await metered(
    new Response('{"input_tokens":4}', { headers: { "content-type": "application/json" } }),
    "/v1/messages/count_tokens",
  )
  expect([counted.reservations, counted.usage]).toEqual([[0], undefined])
  const failed = await metered(
    new Response('{"type":"error"}', {
      status: 529,
      headers: { "content-type": "application/json" },
    }),
  )
  expect(failed.usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
})
