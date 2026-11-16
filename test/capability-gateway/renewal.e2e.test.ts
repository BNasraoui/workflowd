import { expect, test } from "bun:test"
import { sign, createPrivateKey } from "node:crypto"
import {
  client,
  gateways,
  heldEnd,
  heldStart,
  processGateway,
  proof,
  renewalBody,
  runnerKey,
  seedLease,
  sse,
  withGateway,
  type Fixture,
  type Gateway,
} from "./gateway-process"
import { capabilityDigest } from "../../src/capability-gateway/store"
import {
  maxRenewalBody,
  renewalMessage,
  sessionKeyPair,
  signRenewal,
} from "../../deploy/sandbox/renewal.mjs"

/** Whether the gateway revoked the run, and the end reason that it keeps for it. */
const ending = (f: Fixture) =>
  f.gatewaySql(
    (sql) => sql`SELECT revoked,end_reason AS endReason FROM capability_grants WHERE run_id='run'`,
  )
const goesOn = [{ revoked: 0, endReason: null }]
const twoHolders = [{ revoked: 1, endReason: "two holders" }]

/**
 * Reads the stream of `response` to its end, as an event: each event of `events` gets `label`
 * then, and the text and whether the stream ended whole or was cut come back.
 */
const readToEnd = async (response: Response, events: Array<string>, label: string) => {
  const reader = response.body!.getReader()
  let text = ""
  try {
    for (let item = await reader.read(); !item.done; item = await reader.read())
      text += Buffer.from(item.value).toString()
    events.push(`${label} ended`)
  } catch {
    events.push(`${label} cut`)
  }
  return text
}

/**
 * Opens the run's session on `gateway`; its run token lives `seconds` when that is short. The
 * grant comes with the run's channel, which each renewal's signature names.
 */
const opened = async (
  f: Fixture,
  gateway: Gateway,
  seconds: number | null,
  lease = { lease: "lease", run: "78" },
) => {
  const runner = client(gateway)
  await f.tokenSeconds(seconds)
  const { audience, channel } = await runner.audience(lease.lease)
  const answer = await runner.session(
    proof(audience, `jti-${lease.run}`, { lease: lease.lease, claims: { run_id: lease.run } }),
  )
  expect(answer.status).toBe(200)
  const grant = await runner.grant(answer)
  await f.tokenSeconds(null)
  return { ...grant, channel }
}

for (const [mode, start] of gateways) {
  test(`[${mode}] a run token with more than 330 seconds left is not renewed, and the refusal is final`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, null)
      expect(grant.expiresAt - Date.now()).toBeGreaterThan(330000)
      const mints = await f.mints()
      const early = await relay.renew(grant.token, grant.channel)
      expect(early.status).toBe(403)
      expect(await f.mints()).toBe(mints)
      expect(await (await relay.call(grant.token)).text()).toBe(sse)
    })
  }, 60000)

  test(`[${mode}] the relay renews at its renewAt three to five minutes before the token expires`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 300)
      // The relay is told to renew three to five minutes before the token expires.
      expect(grant.renewAt).toBeLessThanOrEqual(grant.expiresAt - 180000)
      expect(grant.renewAt).toBeGreaterThanOrEqual(
        Math.min(grant.expiresAt - 300000, Date.now() - 1000),
      )
      const renewed = await relay.renew(grant.token, grant.channel)
      expect(renewed.status).toBe(200)
      const next = await relay.grant(renewed)
      expect(next.expiresAt).toBeGreaterThan(grant.expiresAt)
      expect(next.renewAt).toBeLessThanOrEqual(next.expiresAt - 180000)
      expect(await (await relay.call(next.token)).text()).toBe(sse)
    })
  }, 60000)

  test(`[${mode}] near the run's deadline, a renewal that would not outlive the token is refused`, async () => {
    await withGateway(start, async (f, gateway) => {
      // Near the run's deadline a successor cannot outlive its predecessor.
      await f.store(seedLease("run-n", "lease-n", 79, true, Date.now() - 285 * 60000 + 250000))
      await f.reconcile()
      const relay = client(gateway)
      const grant = await opened(f, gateway, null, { lease: "lease-n", run: "79" })
      expect(grant.expiresAt - Date.now()).toBeLessThan(250000)
      const mints = await f.mints()
      const refused = await relay.renew(grant.token, grant.channel)
      expect(refused.status).toBe(403)
      expect(await f.mints()).toBe(mints)
    })
  }, 60000)

  test(`[${mode}] a renewal whose answer was lost is asked again and gives a working token, and the one it replaces stops`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const lost = await relay.grant(await relay.renew(grant.token, grant.channel))
      // The relay never got `lost`: it asks again for the same predecessor.
      const again = await relay.renew(grant.token, grant.channel)
      expect(again.status).toBe(200)
      const next = await relay.grant(again)
      expect(next.token).not.toBe(lost.token)
      expect((await relay.call(lost.token)).status).toBe(403)
      expect(await (await relay.call(next.token)).text()).toBe(sse)
      // Once the successor has renewed, it is the run's one token.
      await f.tokenSeconds(null)
      expect((await relay.renew(next.token, grant.channel)).status).toBe(200)
      expect(await ending(f)).toEqual(goesOn)
    })
  }, 60000)
  test(`[${mode}] the successor of one run token is replaced at most three times; a later renewal is refused without a mint`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const first = await relay.renew(grant.token, grant.channel)
      expect(first.status).toBe(200)
      let newest = (await relay.grant(first)).token
      for (let replaced = 1; replaced <= 3; replaced++) {
        const again = await relay.renew(grant.token, grant.channel)
        expect(again.status).toBe(200)
        newest = (await relay.grant(again)).token
      }
      const minted = await f.mints()
      const fourth = await relay.renew(grant.token, grant.channel)
      expect(fourth.status).toBe(403)
      expect(await f.mints()).toBe(minted)
      expect(await (await relay.call(newest)).text()).toBe(sse)
    })
  }, 60000)
}

test("a renewal asked again after a gateway restart gives a working token, and the one it replaces stops", async () => {
  await withGateway(processGateway, async (f, first) => {
    const grant = await opened(f, first, 300)
    const lost = await client(first).grant(await client(first).renew(grant.token, grant.channel))
    await first.stop()
    const second = await processGateway(f)
    try {
      const relay = client(second)
      const again = await relay.renew(grant.token, grant.channel, 2)
      expect(again.status).toBe(200)
      const next = await relay.grant(again)
      expect(await (await relay.call(next.token)).text()).toBe(sse)
      expect((await relay.call(lost.token)).status).toBe(403)
    } finally {
      await second.stop()
    }
  })
}, 60000)

test("the gateway deletes the rows of expired run tokens and of expired used proofs", async () => {
  await withGateway(processGateway, async (f, first) => {
    const grant = await opened(f, first, null)
    await first.stop()
    const expired = "e".repeat(64)
    const following = "f".repeat(64)
    await f.gatewaySql(
      (sql) => sql`INSERT INTO capability_tokens(digest,run_id,expires_at,session)
        VALUES(${expired},'run',${Date.now() - 1000},1)`,
    )
    await f.gatewaySql(
      (sql) => sql`INSERT INTO capability_tokens(digest,run_id,predecessor,expires_at,session)
        VALUES(${following},'run',${expired},${Date.now() + 600000},1)`,
    )
    await f.gatewaySql(
      (sql) => sql`INSERT INTO capability_proofs(jti_digest,run_id,expires_at)
        VALUES(${"d".repeat(64)},'run',${Date.now() - 1000})`,
    )
    const second = await processGateway(f)
    try {
      const rows = () =>
        f.gatewaySql(
          (sql) => sql`SELECT (SELECT count(*) FROM capability_tokens) AS tokens,
            (SELECT count(*) FROM capability_proofs) AS proofs,
            (SELECT count(*) FROM capability_tokens WHERE predecessor IS NOT NULL) AS linked`,
        )
      for (let waited = 0; waited < 50; waited++) {
        if ((await rows())[0]?.tokens === 2) break
        await Bun.sleep(100)
      }
      // The session's token and the following token stay; the used proof of the session stays.
      expect(await rows()).toEqual([{ tokens: 2, proofs: 1, linked: 0 }])
      expect(await (await client(second).call(grant.token)).text()).toBe(sse)
    } finally {
      await second.stop()
    }
  })
}, 60000)

for (const [mode, start] of gateways) {
  test(`[${mode}] a renewal with no signature or attempt number, the body {}, a signature by another key, over another predecessor, channel or number, of a wrong length or form, an attempt number that is not canonical, is negative, zero or over the bound, or a body over the bound is refused; it mints nothing, and the relay's own renewal goes on`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const digest = capabilityDigest(grant.token)
      const valid = signRenewal(runnerKey.privateKey, grant.channel, digest, "1")
      const bytes = Buffer.from(valid, "base64url")
      const signed = (signature: unknown, attempt: unknown = "1") =>
        JSON.stringify({ signature, attempt })
      // A valid signature of the session key over the exact text of an attempt that is refused.
      const key = createPrivateKey({
        key: Buffer.from(runnerKey.privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
      })
      const numbered = (attempt: string) =>
        signed(
          sign(null, renewalMessage(grant.channel, digest, attempt), key).toString("base64url"),
          attempt,
        )
      const bodies = [
        "",
        "{}",
        JSON.stringify({ signature: valid }),
        signed(""),
        signed(null),
        JSON.stringify({ signature: valid, attempt: "1", predecessor: digest }),
        signed(signRenewal(sessionKeyPair().privateKey, grant.channel, digest, "1")),
        signed(signRenewal(runnerKey.privateKey, grant.channel, "0".repeat(64), "1")),
        signed(signRenewal(runnerKey.privateKey, "0".repeat(64), digest, "1")),
        signed(valid, "2"),
        signed(valid, 1),
        signed(bytes.subarray(0, 63).toString("base64url")),
        signed(Buffer.concat([bytes, Buffer.from([0])]).toString("base64url")),
        signed(bytes.toString("base64")),
        signed(bytes.toString("hex")),
        ...["01", "1.0", "+1", "1e0", " 1", "1 ", "0", "-1", "1000000000", "0x1"].map(numbered),
        signed(valid).padEnd(maxRenewalBody + 1, " "),
      ]
      const mints = await f.mints()
      for (const body of bodies) {
        const answer = await relay.renewWith(grant.token, body)
        expect({ body, status: answer.status, text: await answer.text() }).toEqual({
          body,
          status: 403,
          text: "",
        })
      }
      expect(await f.mints()).toBe(mints)
      const state = () =>
        f.gatewaySql(
          (sql) => sql`SELECT (SELECT count(*) FROM capability_tokens WHERE predecessor=${digest})
            AS successors,(SELECT renewal_attempt FROM capability_bindings) AS attempt`,
        )
      expect(await state()).toEqual([{ successors: 0, attempt: 0 }])
      // A party that holds only a copy of the run token signs with a key of its own.
      expect(
        (await client(gateway, sessionKeyPair()).renew(grant.token, grant.channel)).status,
      ).toBe(403)
      // The highest number takes the bound's nine digits; the same signature in a body at the
      // bound, and the relay's own renewal, are taken.
      expect(numbered("999999999").length).toBeLessThanOrEqual(maxRenewalBody)
      const renewed = await relay.renewWith(grant.token, signed(valid).padEnd(maxRenewalBody, " "))
      expect(renewed.status).toBe(200)
      expect(await state()).toEqual([{ successors: 1, attempt: 1 }])
      expect(await (await relay.call((await relay.grant(renewed)).token)).text()).toBe(sse)
      expect(await ending(f)).toEqual(goesOn)
    })
  }, 60000)

  test(`[${mode}] two requests of one renewal with the same attempt number that arrive together leave one valid successor: one is taken, the other is refused, and the run goes on`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      // Both renewals are checked and minting at once.
      await f.slowMints(true)
      const body = renewalBody(runnerKey.privateKey, grant.channel, grant.token, 1)
      const answers = [relay.renewWith(grant.token, body), relay.renewWith(grant.token, body)]
      await f.mintsRunning(2)
      await f.slowMints(false)
      const responses = await Promise.all(answers)
      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 403])
      const taken = responses.find((response) => response.status === 200)!
      const successor = (await relay.grant(taken)).token
      expect(await (await relay.call(successor)).text()).toBe(sse)
      expect(
        await f.gatewaySql(
          (sql) => sql`SELECT count(*) AS successors FROM capability_tokens
            WHERE predecessor=${capabilityDigest(grant.token)}`,
        ),
      ).toEqual([{ successors: 1 }])
      expect(await ending(f)).toEqual(goesOn)
    })
  }, 60000)

  test(`[${mode}] a copy of the relay's renewal request, sent again before and after the successor's first call, has no effect: no mint, no new successor, no removal and no revoke, and the run goes on`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const copied = renewalBody(runnerKey.privateKey, grant.channel, grant.token, 1)
      const successor = (await relay.grant(await relay.renewWith(grant.token, copied))).token
      const state = () =>
        f.gatewaySql(
          (sql) => sql`SELECT digest FROM capability_tokens
            WHERE predecessor=${capabilityDigest(grant.token)}`,
        )
      const before = await state()
      expect(before).toEqual([{ digest: capabilityDigest(successor) }])
      const mints = await f.mints()
      const replay = async () => {
        const answer = await client(gateway, sessionKeyPair()).renewWith(grant.token, copied)
        expect([answer.status, await answer.text()]).toEqual([403, ""])
        expect(await f.mints()).toBe(mints)
        expect(await state()).toEqual(before)
        expect(await ending(f)).toEqual(goesOn)
      }
      await replay()
      expect(await (await relay.call(successor)).text()).toBe(sse)
      await replay()
      expect(await (await relay.call(successor)).text()).toBe(sse)
      // The relay's own next renewal, with its next number, is taken.
      await f.tokenSeconds(null)
      expect((await relay.renew(successor, grant.channel, 2)).status).toBe(200)
    })
  }, 60000)

  test(`[${mode}] a first renewal request that arrives after the relay's retry was taken and its successor made a call has no effect, and the run goes on`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const first = renewalBody(runnerKey.privateKey, grant.channel, grant.token, 1)
      const retry = await relay.renewWith(
        grant.token,
        renewalBody(runnerKey.privateKey, grant.channel, grant.token, 2),
      )
      expect(retry.status).toBe(200)
      const successor = (await relay.grant(retry)).token
      expect(await (await relay.call(successor)).text()).toBe(sse)
      const mints = await f.mints()
      const late = await relay.renewWith(grant.token, first)
      expect([late.status, await late.text()]).toEqual([403, ""])
      expect(await f.mints()).toBe(mints)
      expect(await ending(f)).toEqual(goesOn)
      expect(await (await relay.call(successor)).text()).toBe(sse)
    })
  }, 60000)

  test(`[${mode}] a successor that a second holder used ends the run when the relay asks again with its next number: both tokens are refused, the open stream of each token ends on the revoke, and the end reason is two holders`, async () => {
    // The sweep of stale streams runs at the gateway's start and then after the test's time limit:
    // only the revoke can end the streams.
    await withGateway(
      start,
      async (f, gateway) => {
        const relay = client(gateway)
        const grant = await opened(f, gateway, 200)
        await f.tokenSeconds(300)
        const release = f.holdStream()
        const events: Array<string> = []
        const early = await relay.call(grant.token)
        expect(early.status).toBe(200)
        const earlyRead = readToEnd(early, events, "predecessor stream")
        // The answer of the relay's renewal reaches a second client and never the relay.
        const taken = await relay.grant(await relay.renew(grant.token, grant.channel))
        const second = client(gateway, sessionKeyPair())
        const stream = await second.call(taken.token)
        expect(stream.status).toBe(200)
        const takenRead = readToEnd(stream, events, "successor stream")
        expect(await ending(f)).toEqual(goesOn)
        const mints = await f.mints()
        events.push("renewal sent")
        expect((await relay.renew(grant.token, grant.channel)).status).toBe(403)
        expect(await f.mints()).toBe(mints)
        // Neither held stream ends by itself, by the gateway's idle limit of 120 s or by a sweep
        // within the test's time: each ends when the renewal revokes the run.
        await Promise.all([earlyRead, takenRead])
        expect(events[0]).toBe("renewal sent")
        expect(events.toSorted()).toEqual([
          "predecessor stream cut",
          "renewal sent",
          "successor stream cut",
        ])
        expect((await second.call(taken.token)).status).toBe(403)
        expect((await relay.call(grant.token)).status).toBe(403)
        expect(await ending(f)).toEqual(twoHolders)
        if (gateway.output)
          expect(gateway.output()).toMatch(
            /Capability run ended \{\s*runId: "run",\s*reason: "two holders",?\s*\}/,
          )
        release()
      },
      { staleSweepMs: 60000 },
    )
  }, 60000)

  test(`[${mode}] once its successor has made a call, a run token is refused on a new call and its renewal without the key ends nothing, while a stream that it opened earlier runs on to its end`, async () => {
    // Stale streams are swept every 100 ms, and the held stream outlives ten sweeps after the
    // retirement: a gateway that ended retired streams would cut it before its release.
    await withGateway(
      start,
      async (f, gateway) => {
        const relay = client(gateway)
        const grant = await opened(f, gateway, 200)
        await f.tokenSeconds(300)
        const release = f.holdStream()
        const events: Array<string> = []
        const early = await relay.call(grant.token)
        expect(early.status).toBe(200)
        events.push("predecessor stream opened")
        const earlyRead = readToEnd(early, events, "predecessor stream")
        const next = await relay.grant(await relay.renew(grant.token, grant.channel))
        f.setStall(false)
        expect(await (await relay.call(next.token)).text()).toBe(sse)
        expect((await relay.call(grant.token)).status).toBe(403)
        expect(
          (await client(gateway, sessionKeyPair()).renew(grant.token, grant.channel)).status,
        ).toBe(403)
        events.push("predecessor retired")
        await Bun.sleep(1000)
        events.push("upstream released")
        release()
        const text = await earlyRead
        expect(events).toEqual([
          "predecessor stream opened",
          "predecessor retired",
          "upstream released",
          "predecessor stream ended",
        ])
        expect(text).toBe(heldStart + heldEnd)
        expect(await ending(f)).toEqual(goesOn)
        expect(await (await relay.call(next.token)).text()).toBe(sse)
      },
      { staleSweepMs: 100 },
    )
  }, 60000)

  test(`[${mode}] a stream that a retired run token opened is cut at that token's expiry, which is at most 330 seconds after its renewal`, async () => {
    // The sweep of stale streams runs at the gateway's start and then after the test's time limit,
    // and the stream's idle limit is longer: only the token's expiry can cut the stream.
    await withGateway(
      start,
      async (f, gateway) => {
        const relay = client(gateway)
        const grant = await opened(f, gateway, 6)
        await f.tokenSeconds(300)
        const release = f.holdStream()
        try {
          const events: Array<string> = []
          const early = await relay.call(grant.token)
          expect(early.status).toBe(200)
          const earlyRead = readToEnd(early, events, "predecessor stream")
          const renewedAt = Date.now()
          const next = await relay.grant(await relay.renew(grant.token, grant.channel))
          f.setStall(false)
          expect(await (await relay.call(next.token)).text()).toBe(sse)
          events.push("predecessor retired")
          await earlyRead
          const cutAt = Date.now()
          expect(events).toEqual(["predecessor retired", "predecessor stream cut"])
          // The cut comes at the token's expiry, and no token is renewed earlier than 330 s
          // before it expires.
          expect(cutAt).toBeGreaterThanOrEqual(grant.expiresAt)
          expect(grant.expiresAt - renewedAt).toBeLessThanOrEqual(330000)
          expect(await (await relay.call(next.token)).text()).toBe(sse)
        } finally {
          release()
        }
      },
      { staleSweepMs: 60000 },
    )
  }, 60000)
}
