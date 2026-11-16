import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  claudeLogin,
  client,
  sse,
  storedAccess,
  syntheticValue,
  type Origin,
} from "./gateway-process"
import {
  imported,
  loginDirectory,
  loginFile,
  runToken,
  until,
  withCustody,
  works,
} from "./custody-fixture"

/**
 * A renewal of the gateway's Claude login that stops part way, through the gateway process and
 * a fixture OAuth server: a client that goes away, a stop of the gateway, a stop before the
 * rename of the renewed login; and the scope of a renewal answer.
 */

/** A Claude call through the front at `at` that the client gives up when `signal` aborts. */
const callUntil = (at: Origin, token: string, signal: AbortSignal) =>
  client(at).request("/capabilities/v1/providers/anthropic/v1/messages", {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({ model: "fixture-model", stream: true, messages: [] }),
  })

test("a client that goes away while the OAuth server holds the renewal ends its own wait only; the next call uses that renewal", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("hold")
    const gateway = await start()
    const token = await runToken(gateway, "jti-away")
    const away = new AbortController()
    const first = callUntil(gateway, token, away.signal).catch(() => "gone")
    await until(() => oauth.requests().length === 1)
    away.abort()
    expect(await first).toBe("gone")
    await Bun.sleep(300)
    oauth.release()
    const second = await client(gateway).call(token)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(oauth.next().access)
    // The gateway may see the client's end only once the renewal is done: each upstream call it
    // made carries the renewed value, never the old one.
    const sent = f.upstreamRequests().map((request) => request.headers.authorization)
    expect(sent.length).toBeGreaterThan(0)
    expect(new Set(sent)).toEqual(new Set([`Bearer ${oauth.next().access}`]))
  })
}, 30000)

test("a stop of the gateway while the OAuth server holds the renewal: after a start, the same refresh value is sent once more and the call works", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("hold")
    const gateway = await start()
    const token = await runToken(gateway, "jti-stop")
    const first = client(gateway)
      .call(token)
      .catch(() => "gone")
    await until(() => oauth.requests().length === 1)
    await gateway.terminate?.()
    await first
    // The custody process ended with the gateway: the held answer is stored by no one.
    oauth.release()
    await Bun.sleep(300)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(old.claudeAiOauth.accessToken)
    oauth.mode("renew")
    const restarted = await start()
    await works(
      restarted,
      await runToken(restarted, "jti-restart"),
      oauth,
      old.claudeAiOauth.refreshToken,
    )
    expect(oauth.requests()).toHaveLength(2)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(oauth.next().access)
  })
}, 40000)

test("a stop after the renewed login is complete and before its rename: the next call stores it and sends no request", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    // What such a stop leaves: the state written before the request, and the complete new login
    // in a temporary file of mode 0600 beside the old one.
    const renewed = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    const older = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() - 5000,
    )
    await writeFile(
      join(loginDirectory(f), "claude.state"),
      JSON.stringify({ state: "renewing", failures: 0, retryAt: 0 }),
      { mode: 0o600 },
    )
    await writeFile(
      join(loginDirectory(f), `claude.json.${randomUUID()}.tmp`),
      JSON.stringify(renewed),
      { mode: 0o600 },
    )
    // A temporary file that ends earlier, and one cut short, are not the login.
    await writeFile(
      join(loginDirectory(f), `claude.json.${randomUUID()}.tmp`),
      JSON.stringify(older),
      { mode: 0o600 },
    )
    await writeFile(
      join(loginDirectory(f), `claude.json.${randomUUID()}.tmp`),
      JSON.stringify(renewed).slice(0, 60),
      { mode: 0o600 },
    )
    const gateway = await start()
    const token = await runToken(gateway, "jti-tmp")
    const call = await client(gateway).call(token)
    expect(call.status).toBe(200)
    expect(await call.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(0)
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(renewed)
    expect((await readdir(loginDirectory(f))).sort()).toEqual(["claude.json", "claude.lock"])
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${renewed.claudeAiOauth.accessToken}`,
    ])
  })
}, 30000)

test("a renewal answer with no scope keeps the scope; one without user:inference is stored, and calls are refused for that scope", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("unscoped")
    const gateway = await start()
    const token = await runToken(gateway, "jti-scope")
    const call = await client(gateway).call(token)
    expect(call.status).toBe(200)
    expect(await call.text()).toBe(sse)
    const kept = JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth
    expect([kept.accessToken, kept.scopes]).toEqual([
      oauth.next().access,
      ["user:inference", "user:profile"],
    ])

    // The server answers with a narrower scope: it has replaced the refresh value, so the new
    // values are stored, and no call gets an access value.
    await imported(
      f,
      claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000),
    )
    const narrow = { access: syntheticValue("access"), refresh: syntheticValue("refresh") }
    oauth.renewWith(narrow)
    oauth.mode("narrow")
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await client(gateway).call(token)
      expect(refused.status).toBe(503)
      await refused.text()
    }
    expect(oauth.requests()).toHaveLength(2)
    const stored = JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth
    expect([stored.accessToken, stored.refreshToken, stored.scopes]).toEqual([
      narrow.access,
      narrow.refresh,
      ["user:profile"],
    ])
    expect(gateway.output?.()).toContain(
      "custody: the claude login does not hold the scope user:inference",
    )
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(f.upstreamRequests()).toHaveLength(1)
  })
}, 30000)
