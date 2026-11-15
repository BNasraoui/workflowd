import { expect, test } from "bun:test"
import { Effect } from "effect"
import { openSession } from "../../deploy/sandbox/bootstrap-helper.mjs"
import { makeSandboxStore } from "../../src/sandbox/store"
import { client, gateways, proof, seedLease, withGateway } from "./gateway-process"

for (const [mode, start] of gateways) {
  test(`[${mode}] a proof whose header names an x5t opens a session; the x5t is not checked`, async () => {
    await withGateway(start, async (_f, gateway) => {
      const runner = client(gateway.port)
      const { audience } = await runner.audience()
      const answer = await runner.session(
        proof(audience, "jti-x5t", { header: { x5t: "not-a-thumbprint" } }),
      )
      expect(answer.status).toBe(200)
    })
  }, 60000)

  test(`[${mode}] a proof issued up to ten seconds ahead of the gateway's clock is accepted, and an expired one is not`, async () => {
    await withGateway(start, async (_f, gateway) => {
      const runner = client(gateway.port)
      const live = await runner.audience()
      // Issued 15 seconds ahead: refused, however long the gateway takes to check it. The exact
      // leeway is pinned with a set clock in test/sandbox/bootstrap.test.ts.
      const ahead = Math.ceil((Date.now() + 15000) / 1000)
      expect(
        (await runner.session(proof(live.audience, "jti-15", { issuedAt: ahead }))).status,
      ).toBe(403)
      // Expired a second ago: refused, with no leeway.
      const expired = Math.floor(Date.now() / 1000) - 1
      expect(
        (
          await runner.session(
            proof(live.audience, "jti-exp", { issuedAt: expired - 60, claims: { exp: expired } }),
          )
        ).status,
      ).toBe(403)
      // Issued 9 seconds or less ahead (rounded down): accepted.
      const near = Math.floor((Date.now() + 9000) / 1000)
      expect((await runner.session(proof(live.audience, "jti-9", { issuedAt: near }))).status).toBe(
        200,
      )
    })
  }, 60000)
}

test("the runner's helper waits while the gateway answers 503 for its first minute, then opens its session", async () => {
  await withGateway(gateways[0][1], async (f, gateway) => {
    await f.store(seedLease("run-w", "lease-w", null))
    // A fixture clock: each pause of the helper moves it on at once.
    let clock = 0
    let recorded = false
    const statuses: number[] = []
    const send = async (url: URL, init: RequestInit) => {
      const answer = await fetch(
        url.href.replace("https://gateway.fixture.invalid", `http://127.0.0.1:${gateway.port}`),
        init,
      )
      if (url.pathname === "/capabilities/v1/challenge") statuses.push(answer.status)
      return answer
    }
    const sleep = async (milliseconds: number) => {
      clock += milliseconds
      if (clock >= 60000 && !recorded) {
        recorded = true
        await f.store(
          Effect.gen(function* () {
            yield* (yield* makeSandboxStore).recordRun("run-w", 79, 1)
          }),
        )
      }
    }
    let proofs = 0
    const grant = await openSession({
      gateway: "https://gateway.fixture.invalid",
      leaseId: "lease-w",
      issue: async (audience: string) =>
        proof(audience, `jti-${++proofs}`, { lease: "lease-w", claims: { run_id: "79" } }),
      send,
      clock: () => clock,
      sleep,
    })
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(clock).toBeGreaterThanOrEqual(60000)
    expect(statuses.filter((status) => status === 503).length).toBeGreaterThan(5)
    expect(statuses.at(-1)).toBe(200)
    expect(proofs).toBe(1)
  })
}, 60000)

test("the runner's helper gives up after 180 seconds of 503 without using a proof", async () => {
  await withGateway(gateways[0][1], async (f, gateway) => {
    await f.store(seedLease("run-w", "lease-w", null))
    let clock = 0
    let proofs = 0
    await expect(
      openSession({
        gateway: "https://gateway.fixture.invalid",
        leaseId: "lease-w",
        issue: async () => `proof-${++proofs}`,
        send: (url: URL, init: RequestInit) =>
          fetch(
            url.href.replace("https://gateway.fixture.invalid", `http://127.0.0.1:${gateway.port}`),
            init,
          ),
        clock: () => clock,
        sleep: async (milliseconds: number) => {
          clock += milliseconds
        },
      }),
    ).rejects.toThrow("gateway session unavailable")
    expect(clock).toBeGreaterThanOrEqual(180000)
    expect(clock).toBeLessThan(190000)
    expect(proofs).toBe(0)
  })
}, 60000)
