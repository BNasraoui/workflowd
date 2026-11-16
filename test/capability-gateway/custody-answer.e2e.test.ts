import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { claudeLogin, client, sentRefresh, sse, syntheticValue } from "./gateway-process"
import { imported, loginDirectory, loginFile, runToken, withCustody } from "./custody-fixture"
import type { Fixture } from "./gateway-process"

/**
 * The answer of the OAuth server to a renewal, through the gateway process and a fixture OAuth
 * server: a 200 whose other fields custody does not take, a 200 with no renewal value, and an
 * access value that ends within the renewal lead. Each wait is read from custody's state file
 * and passed on the clock that custody reads, so no margin of time decides a case.
 */

const State = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ state: Schema.Literal("renewing"), retryAt: Schema.Number }),
    Schema.Struct({ state: Schema.Literal("renewed"), renewAfter: Schema.Number }),
  ]),
)
/** Custody's state of the login, from its file. */
const stateOf = async (f: Fixture) =>
  Schema.decodeUnknownSync(State)(await readFile(join(loginDirectory(f), "claude.state"), "utf8"))
const Stored = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.Struct({
      accessToken: Schema.String,
      refreshToken: Schema.String,
      expiresAt: Schema.Number,
    }),
  }),
)
const storedOf = async (f: Fixture) =>
  Schema.decodeUnknownSync(Stored)(await readFile(loginFile(f), "utf8")).claudeAiOauth
/** Returns once `Date.now()` is past `time`. */
async function past(time: number) {
  while (Date.now() <= time) await Bun.sleep(time - Date.now() + 1)
}

/** A 200 with `expires_in` of 0: its renewal value is stored, and the call after the wait sends it. */
const expired = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-expired")
    oauth.mode("expired")
    const replaced = oauth.next()
    expect((await client(gateway).call(token)).status).toBe(503)
    expect((await storedOf(f)).refreshToken).toBe(replaced.refresh)
    const state = await stateOf(f)
    if (state.state !== "renewing") throw new Error(`state ${state.state}`)
    oauth.mode("renew")
    oauth.renewWith({ access: syntheticValue("access"), refresh: syntheticValue("refresh") })
    await past(state.retryAt)
    const call = await client(gateway).call(token)
    expect(call.status).toBe(200)
    expect(await call.text()).toBe(sse)
    expect(oauth.requests().map(sentRefresh)).toEqual([
      old.claudeAiOauth.refreshToken,
      replaced.refresh,
    ])
    expect(oauth.requests()[1]!.time).toBeGreaterThanOrEqual(state.retryAt)
  })
}

/** A 200 with no renewal value: the stored one stays, the calls work, and the next renewal sends it. */
const norotate = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-norotate")
    oauth.mode("norotate")
    for (let index = 0; index < 2; index++) {
      const call = await client(gateway).call(token)
      expect(call.status).toBe(200)
      expect(await call.text()).toBe(sse)
    }
    const stored = await storedOf(f)
    expect(stored.accessToken).toBe(oauth.next().access)
    expect(stored.refreshToken).toBe(old.claudeAiOauth.refreshToken)
    expect(oauth.requests()).toHaveLength(1)
    // The stored access value ends; the next call renews with the stored refresh value.
    const document = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ claudeAiOauth: Schema.Record(Schema.String, Schema.Unknown) }),
      ),
    )(await readFile(loginFile(f), "utf8"))
    const ended = { claudeAiOauth: { ...document.claudeAiOauth, expiresAt: Date.now() - 1000 } }
    await writeFile(loginFile(f), JSON.stringify(ended))
    oauth.mode("renew")
    expect((await client(gateway).call(token)).status).toBe(200)
    expect(oauth.requests().map(sentRefresh)).toEqual([
      old.claudeAiOauth.refreshToken,
      old.claudeAiOauth.refreshToken,
    ])
  })
}

/** An access value that ends within the renewal lead does not make each call renew. */
const short = async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-short")
    oauth.mode("short")
    const works = async () => {
      const call = await client(gateway).call(token)
      expect(call.status).toBe(200)
      expect(await call.text()).toBe(sse)
    }
    await works()
    expect(oauth.requests()).toHaveLength(1)
    const first = await stateOf(f)
    if (first.state !== "renewed") throw new Error(`state ${first.state}`)
    // The calls within the wait after the renewal send no request; a call that a slow runner
    // makes after it may renew, as it should.
    await works()
    await works()
    expect(
      oauth.requests().filter(({ time }) => time < first.renewAfter),
      "a call within the wait after a renewal sends no request",
    ).toHaveLength(1)
    const state = await stateOf(f)
    if (state.state !== "renewed") throw new Error(`state ${state.state}`)
    const before = oauth.requests().length
    await past(state.renewAfter)
    await works()
    expect(oauth.requests()).toHaveLength(before + 1)
    expect(oauth.requests().at(-1)!.time).toBeGreaterThanOrEqual(state.renewAfter)
  })
}

test("custody stores a renewal value before it judges the other fields of a 200, keeps the stored one when a 200 has none, and does not renew at each call within the lead", async () => {
  // Each scenario waits in real time; they run at once, each with its own gateway and servers.
  await Promise.all([expired(), norotate(), short()])
}, 40000)
