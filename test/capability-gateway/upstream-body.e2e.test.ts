import { expect, test } from "bun:test"
import { claudeBetas } from "../../src/capability-gateway/claude"
import { client, gateways, proof, sse, withGateway, type Fixture } from "./gateway-process"

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
  "user-agent": "claude-cli/2.1.296 (external, sdk-cli)",
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

  test(`[${mode}] a request of the pinned Claude Code reaches the provider with the same meaning`, async () => {
    await withGateway(start, async (f, gateway) => {
      const token = await runToken(gateway.port)
      const answer = await client(gateway.port).provider(token, pinnedBody, pinnedHeaders)
      expect(answer.status).toBe(200)
      expect(await answer.text()).toBe(sse)
      expect(sent(f)).toHaveLength(1)
      const [request] = sent(f)
      expect(request!.path).toBe("/v1/messages")
      expect(JSON.parse(request!.body)).toEqual(JSON.parse(pinnedBody))
      expect(request!.headers).toMatchObject({
        authorization: "Bearer fixture-access",
        "anthropic-beta": pinnedHeaders["anthropic-beta"],
        "x-claude-code-session-id": pinnedHeaders["x-claude-code-session-id"],
        "user-agent": pinnedHeaders["user-agent"],
      })
      expect(request!.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined()
    })
  }, 60000)
}
