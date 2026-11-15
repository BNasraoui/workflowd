import { expect, test } from "bun:test"
import { connect } from "node:net"
import { Cause, Effect, Exit, Schema } from "effect"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { join } from "node:path"
import { capabilityDigest } from "../../src/capability-gateway/store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { serveCapabilityGateway } from "../../src/capability-gateway-server"
import {
  client,
  fixture,
  inProcessGateway,
  processGateway,
  proof,
  seedLease,
  sse,
  streamEnd,
  type Fixture,
  type Gateway,
} from "./gateway-process"

async function scenario(start: (f: Fixture) => Promise<Gateway>) {
  const f = await fixture()
  await f.store(
    Effect.gen(function* () {
      yield* seedLease("run-b", "lease-b", 79)
      yield* seedLease("run-c", "lease-c", 80)
      yield* seedLease("run-d", "lease-d", 81, false)
    }),
  )
  let gateway = await start(f)
  let other: Gateway | undefined
  try {
    const at = (port = gateway.port) => client(port)
    const url = (path: string) => at().url(path)
    const challenge = (lease: string) => at().challenge(lease)
    const audienceOf = async (lease: string, port?: number) => {
      const issued = await at(port).challenge(lease)
      expect(issued.status).toBe(200)
      expect(issued.headers.get("cache-control")).toBe("no-store")
      const value = Schema.decodeUnknownSync(
        Schema.Struct({ channel: Schema.String, nonce: Schema.String }),
      )(await issued.json())
      return `workflowd:${value.channel}:${value.nonce}`
    }
    const session = (token: string, port?: number) => at(port).session(token)
    const call = (token: string) => at().call(token)
    const renew = (token: string) => at().renew(token)
    const Grant = async (response: Response) => {
      const grant = await at().grant(response)
      expect(grant.deadline).toBeNumber()
      return { ...grant, deadline: grant.deadline ?? 0 }
    }
    const Renewed = (response: Response) => at().grant(response)
    const sessionOfRun = () =>
      f.gatewaySql(
        Effect.fnUntraced(function* (sql) {
          const rows = yield* sql`SELECT session FROM capability_bindings WHERE run_id='run'`
          return rows[0]?.session
        }),
      )

    // (g) An unknown lease and a lease that is not actions-native are not ready for a challenge;
    // a malformed query gets nothing.
    expect((await challenge("other")).status).toBe(503)
    expect((await fetch(url("/capabilities/v1/challenge?lease=lease&x=1"))).status).toBe(403)
    expect((await challenge("lease-d")).status).toBe(503)
    const first = await audienceOf("lease")

    // (c) Another Actions run's proof, and malformed proofs, are refused and consume nothing.
    expect((await session(proof(first, "jti-1", { claims: { run_id: "79" } }))).status).toBe(403)
    expect((await session("not-a-jwt")).status).toBe(403)
    expect(
      (
        await fetch(url("/capabilities/v1/session"), {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(403)
    // (c) Run A's proof on lease B's challenge is refused.
    expect((await session(proof(await audienceOf("lease-b"), "jti-b"))).status).toBe(403)

    // (a) A client sends a complete session request and leaves before the answer. The gateway
    // finishes the session without it; the runner proves itself again and gets the next one.
    await f.slowMints(true)
    const body = JSON.stringify({ token: proof(first, "jti-1") })
    const socket = connect(gateway.port, "127.0.0.1")
    let answered = ""
    socket.on("data", (bytes) => (answered += bytes.toString()))
    socket.write(
      `POST /capabilities/v1/session HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
    // The gateway has read the proof once its run token mint is running.
    for (let tries = 0; (await f.liveMints()) === 0 && tries < 400; tries++) await Bun.sleep(50)
    expect(await f.liveMints()).toBe(1)
    socket.destroy()
    expect(answered).toBe("")
    await f.slowMints(false)
    for (let tries = 0; (await sessionOfRun()) !== 1 && tries < 400; tries++) await Bun.sleep(50)
    expect(await sessionOfRun()).toBe(1)

    // (b) The used proof, re-posted, is refused.
    expect((await session(proof(first, "jti-1"))).status).toBe(403)

    const second = await audienceOf("lease")
    const granted = await session(proof(second, "jti-2"))
    expect(granted.status).toBe(200)
    const grant = await Grant(granted)
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // A run token lives at most 15 minutes and is renewed 10 to 12 minutes in.
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(900000)
    expect(grant.expiresAt - Date.now()).toBeGreaterThan(840000)
    expect(grant.renewAt - Date.now()).toBeGreaterThan(10 * 60000 - 10000)
    expect(grant.renewAt - Date.now()).toBeLessThanOrEqual(12 * 60000)
    expect(grant.renewAt).toBeLessThanOrEqual(grant.deadline)

    const answer = await call(grant.token)
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe(sse)
    expect((await call("x".repeat(43))).status).toBe(403)

    // A token with more than 330 seconds left is not renewed; in its last minutes it is.
    expect((await renew(grant.token)).status).toBe(403)
    await f.gatewaySql(
      (sql) => sql`UPDATE capability_tokens SET expires_at=${Date.now() + 300000}
          WHERE digest=${capabilityDigest(grant.token)}`,
    )
    const renewed = await renew(grant.token)
    expect(renewed.status).toBe(200)
    const next = await Renewed(renewed)
    expect(next.token).not.toBe(grant.token)
    expect(next.renewAt - Date.now()).toBeLessThanOrEqual(12 * 60000)
    expect(await (await call(next.token)).text()).toBe(sse)

    // The gateway restarts; the run's next call succeeds on the same binding.
    await gateway.stop()
    gateway = await start(f)
    expect(await (await call(next.token)).text()).toBe(sse)

    // workflowd reconciles when it starts; a live run stays granted.
    await f.reconcile()
    expect(await (await call(next.token)).text()).toBe(sse)

    // (e) A new session, opened through another gateway on the same store, ends a live stream
    // on the earlier session's token.
    f.setStall(true)
    const live = await call(next.token)
    expect(live.status).toBe(200)
    const reader = live.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    other = await start({
      ...f,
      env: {
        ...f.env,
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
          ...f.config,
          controlSocket: join(f.root, "control-2", "gateway.sock"),
        }),
      },
      reconcile: async () => undefined,
    })
    const third = await session(proof(await audienceOf("lease", other.port), "jti-3"), other.port)
    expect(third.status).toBe(200)
    const current = await Grant(third)
    expect(await streamEnd(reader, 10000)).toBe("ended")
    f.setStall(false)
    await other.stop()
    other = undefined

    // (d) The earlier token and its renewed successor are refused on a call and on renewal; a
    // session post of that token, or of a used proof for a fresh challenge, is refused.
    for (const token of [grant.token, next.token]) {
      expect((await call(token)).status).toBe(403)
      expect((await renew(token)).status).toBe(403)
      expect((await session(token)).status).toBe(403)
    }
    const replaced = await audienceOf("lease")
    expect((await session(proof(replaced, "jti-2"))).status).toBe(403)
    expect(await (await call(current.token)).text()).toBe(sse)

    // (f) Asking again gives the same unused challenge; asking costs the run nothing.
    for (let asked = 0; asked < 10; asked++) expect(await audienceOf("lease")).toBe(replaced)
    expect(await (await call(current.token)).text()).toBe(sse)

    // (g) A releasing lease and an ended run get no challenge.
    await f.store(
      Effect.gen(function* () {
        yield* (yield* makeSandboxStore).beginRelease("run-b")
        yield* (yield* AgentRunStore).cancel({ runId: "run-c", now: new Date() })
      }),
    )
    await f.reconcile()
    expect((await challenge("lease-b")).status).toBe(503)
    expect((await challenge("lease-c")).status).toBe(503)

    // workflowd's revoke on the control socket aborts a live stream at once.
    f.setStall(true)
    const stream = await call(current.token)
    expect(stream.status).toBe(200)
    const streamed = stream.body!.getReader()
    expect((await streamed.read()).done).toBe(false)
    await f.daemon((capability) => capability.revoke("run"))
    expect(await streamEnd(streamed, 10000)).toBe("ended")
    expect((await call(current.token)).status).toBe(403)
  } finally {
    await other?.stop()
    await gateway.stop()
    await f.close()
  }
}

test("the gateway process binds a run by OIDC session, re-proves after a lost answer and keeps it across restarts", async () => {
  await scenario(processGateway)
}, 60000)

test("the gateway server in this process serves the same session API", async () => {
  await scenario(inProcessGateway)
}, 60000)

test("the gateway process refuses to start without its configuration", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(serveCapabilityGateway({ WORKFLOWD_DATABASE_PATH: ":memory:" })),
  )
  const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  expect(failure instanceof Error && String(failure.cause)).toBe(
    "Error: WORKFLOWD_CAPABILITY_GATEWAY is required",
  )
})
