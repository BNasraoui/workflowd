import { expect, test } from "bun:test"
import { client, gateways, proof, seedLease, withGateway } from "./gateway-process"

for (const [mode, start] of gateways) {
  test(`[${mode}] the gateway fetches the job keys once in ten minutes, and once more a minute for a new key id`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway.port)
      const { audience } = await runner.audience()
      // Proofs for the live challenge that do not verify: a foreign run, a broken signature.
      for (const jti of ["a", "b", "c"])
        expect(
          (await runner.session(proof(audience, jti, { claims: { run_id: "79" } }))).status,
        ).toBe(403)
      expect((await runner.session(`${proof(audience, "d").slice(0, -4)}AAAA`)).status).toBe(403)
      expect(f.keyFetches()).toBe(1)
      expect((await runner.session(proof(audience, "e"))).status).toBe(200)
      const next = await runner.audience()
      expect((await runner.session(proof(next.audience, "f"))).status).toBe(200)
      expect(f.keyFetches()).toBe(1)
      // A key id that the cached set does not hold fetches again, at most once a minute.
      for (const jti of ["g", "h", "i"]) {
        const live = await runner.audience()
        expect(
          (await runner.session(proof(live.audience, jti, { header: { kid: "rotated" } }))).status,
        ).toBe(403)
      }
      expect(f.keyFetches()).toBe(2)
    })
  }, 60000)

  test(`[${mode}] at most four run tokens are minted at once, and a fifth request gets 503 without a mint`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runs = [
        { lease: "lease", run: "78" },
        { lease: "lease-2", run: "79" },
        { lease: "lease-3", run: "80" },
        { lease: "lease-4", run: "81" },
        { lease: "lease-5", run: "82" },
      ]
      for (const { lease, run } of runs.slice(1))
        await f.store(seedLease(`run-${run}`, lease, Number(run)))
      const runner = client(gateway.port)
      const proofs = await Promise.all(
        runs.map(async ({ lease, run }) =>
          proof((await runner.audience(lease)).audience, `jti-${run}`, {
            lease,
            claims: { run_id: run },
          }),
        ),
      )
      await f.slowMints(true)
      const answers = proofs.map((token) => runner.session(token).then((answer) => answer.status))
      const first = await Promise.race(answers)
      expect(first).toBe(503)
      for (let waited = 0; (await f.liveMints()) < 4 && waited < 100; waited++) await Bun.sleep(50)
      expect(await f.liveMints()).toBe(4)
      await f.slowMints(false)
      const statuses = await Promise.all(answers)
      expect(statuses.filter((status) => status === 200)).toHaveLength(4)
      expect(statuses.filter((status) => status === 503)).toHaveLength(1)
      expect(await f.peakMints()).toBe(4)
      expect(await f.mints()).toBe(4)
    })
  }, 60000)
}
