import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { client, gateways, proof, seedLease, withGateway } from "./gateway-process"

for (const [mode, start] of gateways) {
  test(`[${mode}] many challenge requests without a proof do not stop a run from opening its eight sessions`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway.port)
      for (let session = 1; session <= 8; session++) {
        const first = await runner.audience()
        // Anyone may ask for the lease's challenge as often as it likes: the answer stays the same.
        for (let asked = 0; asked < 12; asked++)
          expect((await runner.audience()).audience).toBe(first.audience)
        const opened = await runner.session(proof(first.audience, `jti-${session}`))
        expect(opened.status).toBe(200)
        expect((await runner.grant(opened)).token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      }
      expect(await f.mints()).toBe(8)
    })
  }, 60000)

  test(`[${mode}] a run opens at most eight sessions, and a proof that is not verified uses none of them`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway.port)
      const { audience } = await runner.audience()
      for (const claims of [{ run_id: "79" }, { repository_owner_id: "2" }, { exp: 1 }])
        expect((await runner.session(proof(audience, "jti-refused", { claims }))).status).toBe(403)
      for (let session = 1; session <= 8; session++) {
        const next = await runner.audience()
        expect((await runner.session(proof(next.audience, `jti-${session}`))).status).toBe(200)
      }
      const ninth = await runner.audience()
      expect((await runner.session(proof(ninth.audience, "jti-9"))).status).toBe(403)
      expect(await f.mints()).toBe(8)
    })
  }, 60000)
}

test("a lease that does not exist and a lease whose Actions run is not recorded get the same answer", async () => {
  await withGateway(gateways[0][1], async (f, gateway) => {
    await f.store(seedLease("run-u", "lease-u", null))
    await f.store(seedLease("run-s", "lease-s", 82, false))
    const runner = client(gateway.port)
    const answers = await Promise.all(
      ["lease-none", "lease-u", "lease-s"].map(async (lease) => {
        const answer = await runner.challenge(lease)
        return { status: answer.status, body: await answer.text() }
      }),
    )
    expect(answers[0]?.status).toBe(503)
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    // Once the daemon records the run, the same lease gets its challenge.
    await f.sql(
      (sql) =>
        sql`UPDATE sandbox_leases SET actions_run_id=84,actions_attempt=1 WHERE lease_id='lease-u'`,
    )
    expect((await runner.challenge("lease-u")).status).toBe(200)
  })
}, 60000)

for (const [mode, start] of gateways)
  test(`[${mode}] a proof for a nonce that is not the live one, or for a used proof, fetches no key and mints nothing`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway.port)
      const live = await runner.audience()
      const other = `workflowd:${live.channel}:${randomBytes(32).toString("hex")}`
      expect((await runner.session(proof(other, "jti-other"))).status).toBe(403)
      await f.sql(
        (sql) => sql`UPDATE capability_bindings SET challenge_expires=${Date.now() - 1000}`,
      )
      expect((await runner.session(proof(live.audience, "jti-expired"))).status).toBe(403)
      expect(f.keyFetches()).toBe(0)
      expect(await f.mints()).toBe(0)
      const next = await runner.audience()
      expect(next.audience).not.toBe(live.audience)
      expect((await runner.session(proof(next.audience, "jti-used"))).status).toBe(200)
      const fetched = f.keyFetches()
      expect(fetched).toBeGreaterThan(0)
      const again = await runner.audience()
      expect((await runner.session(proof(again.audience, "jti-used"))).status).toBe(403)
      expect(await f.mints()).toBe(1)
      expect(f.keyFetches()).toBe(fetched)
    })
  }, 60000)
