import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
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
 * Renewal of the gateway's Claude login through the gateway process, against a fixture OAuth
 * server: a fault and a busy server leave the login and wait, and the gateway's time limit of a
 * call ends that call's wait only.
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

/** A 429 waits for its Retry-After when that is longer than the first wait. */
const limited = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-limited")
    // 429 with Retry-After 7: longer than the first wait of 5 seconds.
    oauth.mode("limited", { retryAfter: 7 })
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const limitedAt = Date.now()
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, limitedAt + 7000)
    await works(gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth.refreshToken).toBe(
      oauth.next().refresh,
    )
  })
}

/** A 503 waits the first wait, 5 seconds; the in-process cases show the doubling and its cap. */
const busy = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-busy")
    oauth.mode("busy")
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const busyAt = Date.now()
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, busyAt + 5000)
    await works(gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(oauth.requests().map(sentRefresh)).toEqual([
      old.claudeAiOauth.refreshToken,
      old.claudeAiOauth.refreshToken,
    ])
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(oauth.next().access)
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
  await Promise.all([silent(), limited(), busy(), invalid(), timer()])
}, 40000)
