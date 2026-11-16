import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { join } from "node:path"
import { Schema } from "effect"
import {
  claudeLogin,
  client,
  sentRefresh,
  sse,
  storedAccess,
  syntheticValue,
  type Fixture,
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
} from "./custody-fixture"

/**
 * Renewal of the gateway's Claude login through the gateway process, against a fixture OAuth
 * server: a fault and a busy server leave the login and wait, and the gateway's time limit of a
 * call ends that call's wait only.
 */

/** Custody's state of the login: its failed tries, and the time before which it sends nothing. */
const stateOf = async (f: Fixture) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ failures: Schema.Number, retryAt: Schema.Number })),
  )(await readFile(join(loginDirectory(f), "claude.state"), "utf8"))

/**
 * After a failed try: calls on `token` each get 503 and ask the OAuth server nothing, until the
 * one that renews with `old`, which works. Its request comes no sooner than the `retryAt` that
 * custody wrote, on the clock that custody reads: no margin of time decides the case. A slow
 * runner whose first call comes after `retryAt` makes no quiet call, and the case still holds.
 */
async function renewsAfterWait(
  f: Fixture,
  gateway: Gateway,
  token: string,
  oauth: OAuthFixture,
  old: string,
) {
  const { retryAt } = await stateOf(f)
  const before = oauth.requests().length
  for (;;) {
    const call = await client(gateway).call(token)
    const text = await call.text()
    if (oauth.requests().length > before) {
      expect([call.status, text]).toEqual([200, sse])
      break
    }
    expect(call.status).toBe(503)
    await Bun.sleep(250)
  }
  expect(oauth.requests()).toHaveLength(before + 1)
  expect(
    oauth.requests()[before]!.time,
    "no request goes out before the wait that custody wrote",
  ).toBeGreaterThanOrEqual(retryAt)
  expect(sentRefresh(oauth.requests()[before])).toBe(old)
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
    const call = await client(gateway).call(token)
    expect(call.status).toBe(503)
    expect(performance.now() - began).toBeGreaterThanOrEqual(5000)
    expect(oauth.requests()).toHaveLength(1)
    // Custody's own limit ended the request: custody wrote the failed try and its cause.
    expect((await stateOf(f)).failures).toBe(1)
    expect(f.upstreamRequests()).toHaveLength(0)
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(old)
    expect(gateway.output?.()).toContain(
      "custody: the OAuth server of claude gave no answer within 5 seconds; custody waits before it asks it again",
    )
    expect(gateway.output?.()).not.toContain("needs a new import")
    oauth.mode("renew")
    await renewsAfterWait(f, gateway, token, oauth, old.claudeAiOauth.refreshToken)
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
    const sentAt = Date.now()
    expect((await client(gateway).call(token)).status).toBe(503)
    const answeredAt = Date.now()
    // Custody read its clock between the call and its answer.
    const { retryAt } = await stateOf(f)
    expect(retryAt - 7000).toBeGreaterThanOrEqual(sentAt)
    expect(retryAt - 7000).toBeLessThanOrEqual(answeredAt)
    oauth.mode("renew")
    await renewsAfterWait(f, gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth.refreshToken).toBe(
      oauth.next().refresh,
    )
  })
}

/** A 503 waits the first wait, 5 seconds, and a second 503 after it waits twice as long. */
const busy = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-busy")
    oauth.mode("busy")
    for (const [failures, wait] of [
      [1, 5000],
      [2, 10000],
    ] as const) {
      if (failures > 1) {
        const { retryAt } = await stateOf(f)
        while (Date.now() <= retryAt) await Bun.sleep(retryAt - Date.now() + 1)
      }
      const sentAt = Date.now()
      expect((await client(gateway).call(token)).status).toBe(503)
      const answeredAt = Date.now()
      const state = await stateOf(f)
      expect(state.failures).toBe(failures)
      expect(state.retryAt - wait).toBeGreaterThanOrEqual(sentAt)
      expect(state.retryAt - wait).toBeLessThanOrEqual(answeredAt)
    }
    oauth.mode("renew")
    await renewsAfterWait(f, gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(oauth.requests().map(sentRefresh)).toEqual([
      old.claudeAiOauth.refreshToken,
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
    expect((await client(gateway).call(token)).status).toBe(503)
    oauth.mode("renew")
    await renewsAfterWait(f, gateway, token, oauth, old.claudeAiOauth.refreshToken)
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
      const call = await client(gateway).call(token)
      expect(call.status).toBe(503)
      expect(oauth.requests()).toHaveLength(0)
      // Custody still waits for the lock: the call ended by the gateway's own limit.
      release()
      released = true
      await until(() => oauth.requests().length === 1)
    } finally {
      if (!released) release()
    }
    const next = await client(gateway).call(token)
    expect(next.status).toBe(200)
    expect(await next.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
  })
}

test("faults and busy answers of the OAuth server leave the login and wait, and the gateway's time limit of a call ends its wait only", async () => {
  // Each scenario waits in real time; they run at once, each with its own gateway and servers.
  await Promise.all([silent(), limited(), busy(), invalid(), timer()])
}, 40000)
