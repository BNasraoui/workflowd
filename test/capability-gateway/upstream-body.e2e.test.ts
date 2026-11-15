import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { claudeBetas } from "../../src/capability-gateway/claude"
import {
  client,
  gateways,
  processGateway,
  proof,
  sse,
  withGateway,
  type Fixture,
} from "./gateway-process"

/** Opens the seeded run's session and gives its run token. */
async function runToken(port: number) {
  const runner = client(port)
  const { audience } = await runner.audience()
  return (await runner.grant(await runner.session(proof(audience, "jti-body")))).token
}

/** The number of times `key` names a member in the JSON text `body`. */
const members = (body: string, key: string) =>
  body.match(new RegExp(`"${key}"\\s*:`, "g"))?.length ?? 0

/** The headers of the pinned Claude Code's messages call that are not set by the transport. */
const pinnedHeaders = {
  accept: "application/json",
  "anthropic-beta": [...claudeBetas].join(","),
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": `claude-cli/${readFileSync("test/resources/claude-code-version", "utf8").trim()} (external, sdk-cli)`,
  "x-app": "cli",
  "x-claude-code-session-id": "3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b",
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Linux",
  "x-stainless-package-version": "0.81.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.11.1",
  "x-stainless-timeout": "600",
}

/** A messages body of the shape the pinned client sends, with fields no check names. */
const pinnedBody = `{"model":"fixture-model","messages":[{"role":"user","content":[{"type":"text","text":"say \\u00e9 ok","cache_control":{"type":"ephemeral","ttl":"1h"}}]}],"system":[{"type":"text","text":"You are Claude Code."}],"tools":[{"name":"Bash","description":"Run","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false}}],"metadata":{"user_id":"fixture"},"max_tokens":32000,"temperature":1.0,"thinking":{"type":"adaptive"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"output_config":{"effort":"high"},"future_field":{"nested":[1,2.5,1e3,null,true]},"stream":true}`

const sent = (f: Fixture) => f.upstreamRequests()

for (const [mode, start] of gateways) {
  test(`[${mode}] a body with a key twice reaches the provider once, with the value the gateway checked`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      const answer = await client(gateway.port).provider(
        token,
        '{"model":"claude-other","stream":true,"messages":[],"model":"fixture-model"}',
      )
      expect(answer.status).toBe(200)
      expect(await answer.text()).toBe(sse)
      expect(sent(f)).toHaveLength(1)
      const body = sent(f)[0]!.body
      expect(members(body, "model")).toBe(1)
      expect(JSON.parse(body)).toEqual({ model: "fixture-model", stream: true, messages: [] })
    })
  }, 60000)

  test(`[${mode}] a number that its JSON text would change is refused; one that keeps its value is sent`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      for (const number of ["9007199254740993", "1e400", "1e-400", "0.10000000000000000000001"])
        expect(
          (
            await client(gateway.port).provider(
              token,
              `{"model":"fixture-model","stream":true,"messages":[],"max_tokens":${number}}`,
            )
          ).status,
        ).toBe(403)
      expect(sent(f)).toEqual([])
      const answer = await client(gateway.port).provider(
        token,
        '{"model":"fixture-model","stream":true,"messages":[],"temperature":1.0,"top_k":1e3,"top_p":-0.5E0,"max_tokens":9007199254740992}',
      )
      expect(answer.status).toBe(200)
      expect(sent(f).map((request) => request.body)).toEqual([
        '{"model":"fixture-model","stream":true,"messages":[],"temperature":1,"top_k":1000,"top_p":-0.5,"max_tokens":9007199254740992}',
      ])
    })
  }, 60000)

  test(`[${mode}] a body that the gateway refuses reaches no provider`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      for (const body of [
        '{"model":"fixture-model","stream":true,"messages":[],"model":"claude-other"}',
        '{"stream":true,"messages":[]}',
        '[{"model":"fixture-model"}]',
        '{"model":"fixture-model"',
      ])
        expect((await client(gateway.port).provider(token, body)).status).toBe(403)
      expect(sent(f)).toEqual([])
    })
  }, 60000)

  test(`[${mode}] an anthropic-beta value outside the recorded list is refused, and the listed values pass`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      const body = JSON.stringify({ model: "fixture-model", stream: true, messages: [] })
      for (const beta of [
        "oauth-2025-04-20,files-api-2025-04-14",
        "oauth-2025-04-20, ",
        "oauth-2025-04-20,OAUTH-2025-04-20",
      ])
        expect(
          (await client(gateway.port).provider(token, body, { "anthropic-beta": beta })).status,
        ).toBe(403)
      expect(sent(f)).toEqual([])
      const listed = [...claudeBetas].join(", ")
      const answer = await client(gateway.port).provider(token, body, { "anthropic-beta": listed })
      expect(answer.status).toBe(200)
      expect(sent(f).map((request) => request.headers["anthropic-beta"])).toEqual([listed])
    })
  }, 60000)

  test(`[${mode}] a request of the pinned Claude Code reaches the provider with the same meaning and exactly the listed headers`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      const answer = await client(gateway.port).provider(token, pinnedBody, pinnedHeaders)
      expect(answer.status).toBe(200)
      expect(await answer.text()).toBe(sse)
      expect(sent(f)).toHaveLength(1)
      const [request] = sent(f)
      expect(request!.path).toBe("/v1/messages")
      expect(JSON.parse(request!.body)).toEqual(JSON.parse(pinnedBody))
      const { host, "content-length": length, connection, ...forwarded } = request!.headers
      expect(host).toMatch(/^127\.0\.0\.1:\d+$/)
      expect([length, connection]).toEqual([String(Buffer.byteLength(request!.body)), "keep-alive"])
      const { "anthropic-dangerous-direct-browser-access": notForwarded, ...listed } = pinnedHeaders
      expect(notForwarded).toBe("true")
      expect(forwarded).toEqual({
        ...listed,
        authorization: "Bearer fixture-access",
        "accept-encoding": "identity",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      })
    })
  }, 60000)
}

/** A valid messages body of exactly `bytes` bytes: one user message padded with `a`. */
const bodyOfSize = (bytes: number) => {
  const head = '{"model":"fixture-model","stream":true,"messages":[{"role":"user","content":"'
  const tail = '"}]}'
  return head + "a".repeat(bytes - head.length - tail.length) + tail
}

/** The most bytes a model call's body may hold. */
const modelBodyLimit = 1048576

for (const [mode, start] of gateways)
  test(`[${mode}] a model call body one byte over 1 MiB is refused before the provider; one of 1 MiB is sent`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      const over = bodyOfSize(modelBodyLimit + 1)
      expect(Buffer.byteLength(over)).toBe(modelBodyLimit + 1)
      expect(JSON.parse(over).model).toBe("fixture-model")
      expect((await client(gateway.port).provider(token, over)).status).toBe(403)
      expect(sent(f)).toEqual([])
      const at = bodyOfSize(modelBodyLimit)
      const answer = await client(gateway.port).provider(token, at)
      expect(answer.status).toBe(200)
      expect(await answer.text()).toBe(sse)
      expect(sent(f).map((request) => request.body)).toEqual([at])
    })
  }, 60000)

/**
 * Sends `body` as a model call, and 200 ms later asks the gateway for a challenge on a second
 * connection. Gives each status, or "late" for a request with no answer by `bound` milliseconds
 * from the first send.
 */
async function answersWithin(port: number, token: string, body: string, bound: number) {
  const signal = AbortSignal.timeout(bound)
  const status = (response: Promise<Response>) =>
    response.then(
      (answer) => answer.status,
      () => "late" as const,
    )
  const runner = client(port)
  const call = status(
    fetch(runner.url("/capabilities/v1/providers/anthropic/v1/messages"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body,
      signal,
    }),
  )
  await Bun.sleep(200)
  const other = status(fetch(runner.url("/capabilities/v1/challenge?lease=lease"), { signal }))
  return Promise.all([call, other])
}

test("[process] a 1 MiB model body whose one number is a 1, zeros and a 1 is answered within 2 s, as is a request on another connection", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const token = await runToken(gateway.port)
    const head = '{"model":"fixture-model","stream":true,"messages":[],"max_tokens":1'
    const tail = "1}"
    const body = head + "0".repeat(modelBodyLimit - head.length - tail.length) + tail
    expect(Buffer.byteLength(body)).toBe(modelBodyLimit)
    expect(await answersWithin(gateway.port, token, body, 2000)).toEqual([403, 200])
    expect(sent(f)).toEqual([])
  })
}, 60000)
