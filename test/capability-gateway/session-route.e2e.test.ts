import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeSandboxStore } from "../../src/sandbox/store"
import {
  client,
  gateways,
  proof,
  runnerKey,
  seedLease,
  startGatewayProcess,
  withGateway,
} from "./gateway-process"
import { sessionKeyPair } from "../../deploy/sandbox/renewal.mjs"

test("a gateway process is ready at its full listening line, and one that ends first is refused", async () => {
  const env = { PATH: process.env.PATH }
  const front = { origin: "https://127.0.0.1:1", ca: "" }
  const partial = await startGatewayProcess(
    [
      process.execPath,
      "-e",
      `process.stdout.write("starting\\nlistening /fixture/fr"); await Bun.sleep(200); process.stdout.write("ont/gateway.sock\\n"); await Bun.sleep(60000)`,
    ],
    env,
    front,
  )
  expect(partial.socket).toBe("/fixture/front/gateway.sock")
  await partial.stop()
  await expect(
    startGatewayProcess([process.execPath, "-e", `console.log("starting")`], env, front),
  ).rejects.toThrow("gateway process exited before listening")
})

for (const [mode, start] of gateways) {
  test(`[${mode}] many challenge requests without a proof do not stop a run from opening its eight sessions`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway)
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
      const runner = client(gateway)
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
    const runner = client(gateway)
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
    await f.store(
      Effect.gen(function* () {
        yield* (yield* makeSandboxStore).recordRun("run-u", 84, 1)
      }),
    )
    await f.reconcile()
    expect((await runner.challenge("lease-u")).status).toBe(200)
  })
}, 60000)

test("a lease that is unknown, of an ended run, or of a revoked binding gets the same not-ready answer, and a malformed lease id is refused", async () => {
  await withGateway(gateways[0][1], async (f, gateway) => {
    const runner = client(gateway)
    await f.store(seedLease("run-ended", "lease-ended", 83))
    await f.store(
      Effect.gen(function* () {
        yield* (yield* AgentRunStore).cancel({ runId: "run-ended", now: new Date() })
      }),
    )
    await runner.audience()
    await f.gatewaySql((sql) => sql`UPDATE capability_bindings SET revoked=1 WHERE run_id='run'`)
    const answers = await Promise.all(
      ["lease-none", "lease-ended", "lease"].map(async (lease) => {
        const answer = await runner.challenge(lease)
        return { status: answer.status, body: await answer.text() }
      }),
    )
    expect(answers).toEqual([
      { status: 503, body: "" },
      { status: 503, body: "" },
      { status: 503, body: "" },
    ])
    expect((await runner.challenge("lease%2F..")).status).toBe(403)
  })
}, 60000)

for (const [mode, start] of gateways)
  test(`[${mode}] a proof for a nonce that is not the live one, or for a used proof, fetches no key and mints nothing`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway)
      const live = await runner.audience()
      const other = `workflowd:${live.channel}:${randomBytes(32).toString("hex")}`
      expect((await runner.session(proof(other, "jti-other"))).status).toBe(403)
      await f.gatewaySql(
        (sql) => sql`UPDATE capability_bindings SET challenge_expires=${Date.now() - 1000}`,
      )
      expect((await runner.session(proof(live.audience, "jti-expired"))).status).toBe(403)
      expect(f.keyFetches()).toBe(0)
      expect(await f.mints()).toBe(0)
      const next = await runner.audience()
      expect(next.audience).not.toBe(live.audience)
      expect((await runner.session(proof(next.audience, "jti-used"))).status).toBe(200)
      expect(f.keyFetches()).toBeGreaterThan(0)
      // A second gateway on the same store starts with no job keys, so a key check would fetch.
      // It takes the control socket once the first one has stopped.
      await gateway.stop()
      const restarted = await start(f)
      try {
        const fetched = f.keyFetches()
        const fresh = client(restarted)
        const again = await fresh.audience()
        expect((await fresh.session(proof(again.audience, "jti-used"))).status).toBe(403)
        expect(f.keyFetches()).toBe(fetched)
        expect(await f.mints()).toBe(1)
        const unused = await fresh.audience()
        expect((await fresh.session(proof(unused.audience, "jti-unused"))).status).toBe(200)
        expect(f.keyFetches()).toBe(fetched + 1)
      } finally {
        await restarted.stop()
      }
    })
  }, 60000)

for (const [mode, start] of gateways) {
  test(`[${mode}] a session post with no key, a key of another form or length, or a key that its proof does not bind is refused with an empty 403, and fetches no key, mints nothing and opens no session`, async () => {
    await withGateway(start, async (f, gateway) => {
      const runner = client(gateway)
      const live = await runner.audience()
      const token = proof(live.audience, "jti-key")
      const raw = Buffer.from(runnerKey.publicKey, "base64url")
      // The last character of 32 bytes in base64url carries two unused bits; here one is set.
      const last = runnerKey.publicKey.at(-1)!
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
      const loose = runnerKey.publicKey.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]
      const posts: ReadonlyArray<unknown> = [
        { token },
        { token, key: null },
        { token, key: 7 },
        { token, key: "" },
        { token, key: runnerKey.publicKey.slice(0, -1) },
        { token, key: `${runnerKey.publicKey}A` },
        { token, key: Buffer.concat([raw, Buffer.from([0])]).toString("base64url") },
        { token, key: raw.subarray(1).toString("base64url") },
        { token, key: raw.toString("hex") },
        { token, key: raw.toString("base64") },
        { token, key: loose },
        // A key of the right form that the proof's audience does not bind.
        { token, key: sessionKeyPair().publicKey },
        // An audience of the nonce alone binds no key.
        {
          token: proof(`workflowd:${live.channel}:${live.nonce}`, "jti-nonce"),
          key: runnerKey.publicKey,
        },
      ]
      for (const body of posts) {
        const answer = await runner.request("/capabilities/v1/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        expect({ body, status: answer.status, text: await answer.text() }).toEqual({
          body,
          status: 403,
          text: "",
        })
      }
      const sessions = () =>
        f.gatewaySql((sql) => sql`SELECT session FROM capability_bindings WHERE run_id='run'`)
      expect({ keys: f.keyFetches(), mints: await f.mints(), sessions: await sessions() }).toEqual({
        keys: 0,
        mints: 0,
        sessions: [{ session: 0 }],
      })
      // The same proof with the key that it binds opens the session: the refusals used nothing.
      expect((await runner.session(token)).status).toBe(200)
      expect(await sessions()).toEqual([{ session: 1 }])
    })
  }, 60000)
}
