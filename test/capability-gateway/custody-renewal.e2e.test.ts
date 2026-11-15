import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { join } from "node:path"
import {
  claudeLogin,
  client,
  sentRefresh,
  sse,
  storedAccess,
  syntheticValue,
  type Gateway,
  type OAuthFixture,
} from "./gateway-process"
import { imported, loginDirectory, loginFile, runToken, withCustody } from "./custody-fixture"

/**
 * Renewal of the gateway's Claude login through the gateway process, against a fixture OAuth
 * server: only a refusal of the renewal value asks for a new import. A client that goes away, the
 * gateway's time limit of a call, a stop of the gateway, a fault and a busy server do not.
 */

/** Calls on `token` until `at` (a time of `Date.now()`): each gets 503, and none asks the OAuth server. */
async function quietUntil(gateway: Gateway, token: string, oauth: OAuthFixture, at: number) {
  const before = oauth.requests().length
  let calls = 0
  while (Date.now() < at - 400) {
    const call = await client(gateway.port).call(token)
    expect(call.status).toBe(503)
    await call.text()
    calls++
    await Bun.sleep(250)
  }
  expect(calls).toBeGreaterThan(0)
  expect(oauth.requests()).toHaveLength(before)
  await Bun.sleep(Math.max(0, at - Date.now()) + 100)
}

/** The call works with the fixture's next access value; the OAuth server got one more request. */
async function works(gateway: Gateway, token: string, oauth: OAuthFixture, old: string) {
  const before = oauth.requests().length
  const call = await client(gateway.port).call(token)
  expect(call.status).toBe(200)
  expect(await call.text()).toBe(sse)
  expect(oauth.requests()).toHaveLength(before + 1)
  expect(sentRefresh(oauth.requests().at(-1))).toBe(old)
}

/** A Claude call on `port` that the client gives up when `signal` aborts. */
const callUntil = (port: number, token: string, signal: AbortSignal) =>
  fetch(client(port).url("/capabilities/v1/providers/anthropic/v1/messages"), {
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

/** Waits until `ready` holds, for at most 10 seconds. */
async function until(ready: () => boolean) {
  const end = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > end) throw new Error("the condition did not come")
    await Bun.sleep(20)
  }
}

test("a client that goes away while the OAuth server holds the renewal ends its own wait only; the next call uses that renewal", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("hold")
    const gateway = await start()
    const token = await runToken(gateway, "jti-away")
    const away = new AbortController()
    const first = callUntil(gateway.port, token, away.signal).catch(() => "gone")
    await until(() => oauth.requests().length === 1)
    away.abort()
    expect(await first).toBe("gone")
    await Bun.sleep(300)
    oauth.release()
    const second = await client(gateway.port).call(token)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(oauth.next().access)
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${oauth.next().access}`,
    ])
  })
}, 30000)

/** An exclusive advisory lock on `path`, as a custody process takes it, until `release`. */
function holdLock(path: string) {
  const libc = dlopen("libc.so.6", {
    open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  const fd = libc.symbols.open(ptr(Buffer.from(`${path}\0`)), 2)
  if (fd < 0 || libc.symbols.flock(fd, 2) !== 0) throw new Error("the lock was not taken")
  return () => {
    libc.symbols.close(fd)
    libc.close()
  }
}

test("a stop of the gateway while the OAuth server holds the renewal: after a start, the same refresh value is sent once more and the call works", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("hold")
    const gateway = await start()
    const token = await runToken(gateway, "jti-stop")
    const first = client(gateway.port)
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
    const call = await client(gateway.port).call(token)
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
    const call = await client(gateway.port).call(token)
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
      const refused = await client(gateway.port).call(token)
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

/** An OAuth server that does not answer leaves the login as it was; no request goes out for 5 seconds, then one does. */
const silent = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("silent")
    const gateway = await start()
    const token = await runToken(gateway, "jti-silent")
    const began = performance.now()
    const call = await client(gateway.port).call(token)
    const failedAt = Date.now()
    const took = performance.now() - began
    expect(call.status).toBe(503)
    expect(took).toBeGreaterThanOrEqual(5000)
    expect(took).toBeLessThan(9000)
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests()).toHaveLength(0)
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(old)
    expect(gateway.output?.()).toContain(
      "custody: the claude login was not renewed; custody waits before it asks the OAuth server again",
    )
    expect(gateway.output?.()).not.toContain("needs a new import")
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, failedAt + 5000)
    await works(gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${oauth.next().access}`,
    ])
  })
}

/** A 429 waits for its Retry-After when that is longer, and a 503 doubles the wait. */
const limited = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const refresh = old.claudeAiOauth.refreshToken
    const gateway = await start()
    const token = await runToken(gateway, "jti-busy")
    // 429 with Retry-After 7: longer than the first wait of 5 seconds.
    oauth.mode("limited", { retryAfter: 7 })
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const limitedAt = Date.now()
    await quietUntil(gateway, token, oauth, limitedAt + 6000)
    expect((await client(gateway.port).call(token)).status).toBe(503)
    expect(oauth.requests()).toHaveLength(1)
    await Bun.sleep(Math.max(0, limitedAt + 7100 - Date.now()))
    // The second failed try, a 503, waits twice the first wait: 10 seconds.
    oauth.mode("busy")
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const busyAt = Date.now()
    expect(oauth.requests()).toHaveLength(2)
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, busyAt + 10000)
    await works(gateway, token, oauth, refresh)
    expect(oauth.requests().map(sentRefresh)).toEqual([refresh, refresh, refresh])
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth.refreshToken).toBe(
      oauth.next().refresh,
    )
  })
}

/** A 400 that is not invalid_grant does not ask for a new import. */
const invalid = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("invalid")
    const gateway = await start()
    const token = await runToken(gateway, "jti-invalid")
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const failedAt = Date.now()
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, failedAt + 5000)
    await works(gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(gateway.output?.()).not.toContain("needs a new import")
  })
}

/** The gateway's time limit of one call ends that call's wait; the renewal goes on and the next call uses it. */
const timer = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-timer")
    // Custody waits up to 15 seconds for the lock; the call waits 10.
    const release = holdLock(join(loginDirectory(f), "claude.lock"))
    let released = false
    try {
      const began = performance.now()
      const call = await client(gateway.port).call(token)
      expect(call.status).toBe(503)
      expect(performance.now() - began).toBeLessThan(12000)
      expect(oauth.requests()).toHaveLength(0)
      release()
      released = true
      await until(() => oauth.requests().length === 1)
    } finally {
      if (!released) release()
    }
    const next = await client(gateway.port).call(token)
    expect(next.status).toBe(200)
    expect(await next.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
  })
}

test("faults and busy answers of the OAuth server leave the login and wait, and the gateway's time limit of a call ends its wait only", async () => {
  // Each scenario waits in real time; they run at once, each with its own gateway and servers.
  await Promise.all([silent(), limited(), invalid(), timer()])
}, 40000)
