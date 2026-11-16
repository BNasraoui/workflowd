import { expect, test } from "bun:test"
import {
  client,
  gateways,
  processGateway,
  proof,
  runnerKey,
  seedLease,
  sse,
  streamEnd,
  withGateway,
  type Fixture,
  type Gateway,
} from "./gateway-process"
import { capabilityDigest } from "../../src/capability-gateway/store"
import { maxRenewalBody, sessionKeyPair, signRenewal } from "../../deploy/sandbox/renewal.mjs"

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
      expect(await f.daemon((capability) => capability.endReason("run"))).toBeNull()
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
      const again = await relay.renew(grant.token, grant.channel)
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
  test(`[${mode}] a renewal with no signature, the body {}, a signature by another key, over another predecessor or channel, of a wrong length or form, or a body over the bound is refused; it mints nothing, and the relay's own renewal goes on`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const digest = capabilityDigest(grant.token)
      const valid = signRenewal(runnerKey.privateKey, grant.channel, digest)
      const bytes = Buffer.from(valid, "base64url")
      const signed = (signature: unknown) => JSON.stringify({ signature })
      const bodies = [
        "",
        "{}",
        signed(""),
        signed(null),
        JSON.stringify({ signature: valid, predecessor: digest }),
        signed(signRenewal(sessionKeyPair().privateKey, grant.channel, digest)),
        signed(signRenewal(runnerKey.privateKey, grant.channel, "0".repeat(64))),
        signed(signRenewal(runnerKey.privateKey, "0".repeat(64), digest)),
        signed(bytes.subarray(0, 63).toString("base64url")),
        signed(Buffer.concat([bytes, Buffer.from([0])]).toString("base64url")),
        signed(bytes.toString("base64")),
        signed(bytes.toString("hex")),
        signed(valid).padEnd(maxRenewalBody + 1, " "),
      ]
      const mints = await f.mints()
      for (const body of bodies) {
        const answer = await relay.renewWith(grant.token, body)
        expect({ body, status: answer.status }).toEqual({ body, status: 403 })
      }
      expect(await f.mints()).toBe(mints)
      expect(
        await f.gatewaySql(
          (sql) =>
            sql`SELECT count(*) AS successors FROM capability_tokens WHERE predecessor=${digest}`,
        ),
      ).toEqual([{ successors: 0 }])
      // A party that holds only a copy of the run token signs with a key of its own.
      expect(
        (await client(gateway, sessionKeyPair()).renew(grant.token, grant.channel)).status,
      ).toBe(403)
      // The same signature in a body at the bound, and the relay's own renewal, are taken.
      const renewed = await relay.renewWith(grant.token, signed(valid).padEnd(maxRenewalBody, " "))
      expect(renewed.status).toBe(200)
      expect(await (await relay.call((await relay.grant(renewed)).token)).text()).toBe(sse)
      expect(await f.daemon((capability) => capability.endReason("run"))).toBeNull()
    })
  }, 60000)

  test(`[${mode}] two renewals of one predecessor that arrive together leave one valid successor, and the run goes on`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      // Both renewals are checked and minting at once.
      await f.slowMints(true)
      const answers = [
        relay.renew(grant.token, grant.channel),
        relay.renew(grant.token, grant.channel),
      ]
      for (let tries = 0; (await f.liveMints()) < 2 && tries < 200; tries++) await Bun.sleep(50)
      expect(await f.liveMints()).toBe(2)
      await f.slowMints(false)
      const granted = await Promise.all(
        answers.map(async (answer) => {
          const response = await answer
          expect(response.status).toBe(200)
          return (await relay.grant(response)).token
        }),
      )
      const calls = await Promise.all(
        granted.map(async (token) => (await relay.call(token)).status),
      )
      expect(calls.toSorted()).toEqual([200, 403])
      expect(await f.daemon((capability) => capability.endReason("run"))).toBeNull()
      expect(await (await relay.call(granted[calls.indexOf(200)]!)).text()).toBe(sse)
    })
  }, 60000)

  test(`[${mode}] a successor that a second holder used ends the run when the relay asks again: both tokens are refused, the open stream ends, and the end reason is two holders`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      // The answer of the relay's renewal reaches a second client and never the relay.
      const taken = await relay.grant(await relay.renew(grant.token, grant.channel))
      const second = client(gateway, sessionKeyPair())
      f.setStall(true)
      const stream = await second.call(taken.token)
      expect(stream.status).toBe(200)
      const reader = stream.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      expect(await f.daemon((capability) => capability.endReason("run"))).toBeNull()
      const mints = await f.mints()
      expect((await relay.renew(grant.token, grant.channel)).status).toBe(403)
      expect(await f.mints()).toBe(mints)
      expect(await streamEnd(reader, 10000)).toBe("ended")
      expect((await second.call(taken.token)).status).toBe(403)
      expect((await relay.call(grant.token)).status).toBe(403)
      expect(await f.daemon((capability) => capability.endReason("run"))).toBe("two holders")
    })
  }, 60000)

  test(`[${mode}] once its successor has made a call, a run token is refused on a new call and its renewal without the key ends nothing, while a stream that it opened earlier runs to its end`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      f.setTrickle(6, 300)
      const early = await relay.call(grant.token)
      expect(early.status).toBe(200)
      const reader = early.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      const next = await relay.grant(await relay.renew(grant.token, grant.channel))
      f.setStall(false)
      expect(await (await relay.call(next.token)).text()).toBe(sse)
      expect((await relay.call(grant.token)).status).toBe(403)
      expect(
        (await client(gateway, sessionKeyPair()).renew(grant.token, grant.channel)).status,
      ).toBe(403)
      expect(await f.daemon((capability) => capability.endReason("run"))).toBeNull()
      let text = Buffer.from(first.value).toString()
      for (let item = await reader.read(); !item.done; item = await reader.read())
        text += Buffer.from(item.value).toString()
      expect(text).toBe(
        Array.from({ length: 6 }, (_, sent) => `event: ping\ndata: ${sent}\n\n`).join(""),
      )
      expect(await (await relay.call(next.token)).text()).toBe(sse)
    })
  }, 60000)
}
