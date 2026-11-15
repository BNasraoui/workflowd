import { expect, test } from "bun:test"
import {
  client,
  gateways,
  processGateway,
  proof,
  seedLease,
  sse,
  withGateway,
  type Fixture,
  type Gateway,
} from "./gateway-process"

/** Opens the run's session on `gateway`; its run token lives `seconds` when that is short. */
const opened = async (
  f: Fixture,
  gateway: Gateway,
  seconds: number | null,
  lease = { lease: "lease", run: "78" },
) => {
  const runner = client(gateway.port)
  await f.tokenSeconds(seconds)
  const { audience } = await runner.audience(lease.lease)
  const answer = await runner.session(
    proof(audience, `jti-${lease.run}`, { lease: lease.lease, claims: { run_id: lease.run } }),
  )
  expect(answer.status).toBe(200)
  const grant = await runner.grant(answer)
  await f.tokenSeconds(null)
  return grant
}

const ended = (reader: { read(): Promise<unknown> }, within: number) =>
  Promise.race([
    reader.read().then(
      () => "ended",
      () => "ended",
    ),
    Bun.sleep(within).then(() => "live"),
  ])

for (const [mode, start] of gateways) {
  test(`[${mode}] a run token with more than 330 seconds left is not renewed, and the refusal is final`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway.port)
      const grant = await opened(f, gateway, null)
      expect(grant.expiresAt - Date.now()).toBeGreaterThan(330000)
      const mints = await f.mints()
      const early = await relay.renew(grant.token)
      expect(early.status).toBe(403)
      expect(await f.mints()).toBe(mints)
      expect(await (await relay.call(grant.token)).text()).toBe(sse)
    })
  }, 60000)

  test(`[${mode}] the relay renews at its renewAt three to five minutes before the token expires`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway.port)
      const grant = await opened(f, gateway, 300)
      // The relay is told to renew three to five minutes before the token expires.
      expect(grant.renewAt).toBeLessThanOrEqual(grant.expiresAt - 180000)
      expect(grant.renewAt).toBeGreaterThanOrEqual(
        Math.min(grant.expiresAt - 300000, Date.now() - 1000),
      )
      const renewed = await relay.renew(grant.token)
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
      const relay = client(gateway.port)
      const grant = await opened(f, gateway, null, { lease: "lease-n", run: "79" })
      expect(grant.expiresAt - Date.now()).toBeLessThan(250000)
      const mints = await f.mints()
      const refused = await relay.renew(grant.token)
      expect(refused.status).toBe(403)
      expect(await f.mints()).toBe(mints)
    })
  }, 60000)

  test(`[${mode}] a renewal whose answer was lost is asked again and gives a working token, and the one it replaces stops`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway.port)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const lost = await relay.grant(await relay.renew(grant.token))
      f.setStall(true)
      const stream = await relay.call(lost.token)
      expect(stream.status).toBe(200)
      const reader = stream.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      f.setStall(false)
      const again = await relay.renew(grant.token)
      expect(again.status).toBe(200)
      const next = await relay.grant(again)
      expect(next.token).not.toBe(lost.token)
      expect(await (await relay.call(next.token)).text()).toBe(sse)
      expect((await relay.call(lost.token)).status).toBe(403)
      expect(await ended(reader, 3000)).toBe("ended")
      // The predecessor stays valid until it expires; its replaced successor does not come back.
      expect(await (await relay.call(grant.token)).text()).toBe(sse)
      // Once the successor has renewed, its predecessor cannot renew again.
      await f.tokenSeconds(null)
      expect((await relay.renew(next.token)).status).toBe(200)
      const refused = await relay.renew(grant.token)
      expect(refused.status).toBe(403)
    })
  }, 60000)
  test(`[${mode}] the successor of one run token is replaced at most three times; a later renewal is refused without a mint`, async () => {
    await withGateway(start, async (f, gateway) => {
      const relay = client(gateway.port)
      const grant = await opened(f, gateway, 200)
      await f.tokenSeconds(300)
      const first = await relay.renew(grant.token)
      expect(first.status).toBe(200)
      let newest = (await relay.grant(first)).token
      for (let replaced = 1; replaced <= 3; replaced++) {
        const again = await relay.renew(grant.token)
        expect(again.status).toBe(200)
        newest = (await relay.grant(again)).token
      }
      const minted = await f.mints()
      const fourth = await relay.renew(grant.token)
      expect(fourth.status).toBe(403)
      expect(await f.mints()).toBe(minted)
      expect(await (await relay.call(newest)).text()).toBe(sse)
    })
  }, 60000)
}

test("a renewal asked again after a gateway restart gives a working token, and the one it replaces stops", async () => {
  await withGateway(processGateway, async (f, first) => {
    const grant = await opened(f, first, 300)
    const lost = await client(first.port).grant(await client(first.port).renew(grant.token))
    await first.stop()
    const second = await processGateway(f)
    try {
      const relay = client(second.port)
      const again = await relay.renew(grant.token)
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
    await f.sql(
      (sql) => sql`INSERT INTO capability_tokens(digest,run_id,expires_at,session)
        VALUES(${expired},'run',${Date.now() - 1000},1)`,
    )
    await f.sql(
      (sql) => sql`INSERT INTO capability_tokens(digest,run_id,predecessor,expires_at,session)
        VALUES(${following},'run',${expired},${Date.now() + 600000},1)`,
    )
    await f.sql(
      (sql) => sql`INSERT INTO capability_proofs(jti_digest,run_id,expires_at)
        VALUES(${"d".repeat(64)},'run',${Date.now() - 1000})`,
    )
    const second = await processGateway(f)
    try {
      const rows = () =>
        f.sql(
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
      expect(await (await client(second.port).call(grant.token)).text()).toBe(sse)
    } finally {
      await second.stop()
    }
  })
}, 60000)
