import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Exit, Schema, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityStore } from "../../src/capability-gateway/store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { serveCapabilityGateway } from "../../src/capability-gateway-server"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { seedCapabilityRun } from "./fixture"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }],
}
const ref = "refs/heads/workflowd/leases/lease"
/** A GitHub Actions OIDC proof for the seeded lease (Actions run 78, attempt 1). */
const proof = (audience: string, jti: string, change: Record<string, string> = {}) => {
  const now = Math.floor(Date.now() / 1000)
  const input = [
    { alg: "RS256", typ: "JWT", kid: "fixture" },
    {
      iss: "https://token.actions.githubusercontent.com",
      aud: audience,
      sub: `repo:fixture@1/repo@12:ref:${ref}`,
      jti,
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
      repository: "fixture/repo",
      repository_id: "12",
      repository_owner_id: "1",
      repository_owner: "fixture",
      actor_id: "56",
      ref,
      sha: "a".repeat(40),
      workflow_ref: `fixture/repo/.github/workflows/agent-sandbox-caller.yml@${ref}`,
      workflow_sha: "a".repeat(40),
      job_workflow_ref: `fixture/repo/.github/workflows/agent-sandbox.yml@${ref}`,
      job_workflow_sha: "a".repeat(40),
      run_id: "78",
      run_attempt: "1",
      event_name: "push",
      runner_environment: "github-hosted",
      ...change,
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".")
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
}

const json =
  <A>(schema: Schema.Codec<A>) =>
  async (response: Response): Promise<A> =>
    Schema.decodeUnknownSync(schema)(await response.json())
const Challenge = json(Schema.Struct({ channel: Schema.String, nonce: Schema.String }))
const Grant = json(
  Schema.Struct({ token: Schema.String, renewAt: Schema.Number, deadline: Schema.Number }),
)
const Renewed = json(Schema.Struct({ token: Schema.String }))
const sse = "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wfd-gateway-session-"))
  await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
  await mkdir(join(root, "run"))
  // The run token provider waits while `slow` exists, so a session request can be cut mid-mint.
  await writeFile(
    join(root, "run.mjs"),
    `import {existsSync} from 'node:fs';import {randomBytes,randomUUID} from 'node:crypto';
while (existsSync(${JSON.stringify(join(root, "slow"))})) await new Promise((r)=>setTimeout(r,50));
process.stdout.write(JSON.stringify({token:randomBytes(32).toString('base64url'),token_id:randomUUID(),expires_at:new Date(Date.now()+Number(process.argv[2])*1000).toISOString()}))`,
  )
  await writeFile(
    join(root, "access.mjs"),
    `process.stdout.write(JSON.stringify({token:"fixture-access",token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))`,
  )
  for (const [name, script, argument] of [
    ["run-capability", "run.mjs", " {ttl}"],
    ["provider-access", "access.mjs", ""],
  ] as const)
    await writeFile(
      join(root, `noscope/providers/${name}.toml`),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${join(root, script)}${argument}"\n`,
      { mode: 0o600 },
    )
  let stall = false
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        stall
          ? new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"))
              },
            })
          : sse,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const database = join(root, "workflowd.db")
  const config = {
    nodeBinary: fixtureExecutable("node"),
    noscope: { binary: fixtureExecutable("noscope"), configHome: root },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 8,
    maxStreamsPerRun: 2,
    listen: { host: "127.0.0.1", port: 0 },
  }
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    WORKFLOWD_DATABASE_PATH: database,
    WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
  }
  const store = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      SqlClient.SqlClient | typeof AgentRunStore.Identifier | Scope.Scope
    >,
  ) =>
    Effect.runPromise(
      Effect.scoped(effect).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: database })),
      ),
    )
  await store(
    Effect.gen(function* () {
      const { sql } = yield* seedCapabilityRun(Date.now(), true)
      yield* sql`UPDATE kernel_agent_runs SET directory=${join(root, "run")} WHERE run_id='run'`
    }),
  )
  const upstreamFn = (url: string, init: RequestInit) =>
    fetch(url.replace("https://api.anthropic.com", `http://127.0.0.1:${upstream.port}`), init)
  return {
    root,
    env,
    config,
    store,
    upstreamFn,
    setStall: (value: boolean) => {
      stall = value
    },
    close: async () => {
      await upstream.stop(true)
      await rm(root, { recursive: true, force: true })
    },
    upstreamPort: upstream.port,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

/** The gateway as its own process: its real entry, with the fixture's keys and upstream. */
async function processGateway(f: Fixture) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { runCapabilityGatewayServer } from ${JSON.stringify(resolve("src/capability-gateway-server.ts"))}
import { Effect } from "effect"
const jwks = ${JSON.stringify(jwks)}
Effect.runFork(runCapabilityGatewayServer(process.env, {
  keys: async () => jwks,
  upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", "http://127.0.0.1:${f.upstreamPort}"), init),
}))`,
    ],
    { cwd: resolve("."), env: f.env, stdout: "pipe", stderr: "inherit" },
  )
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const part = await reader.read()
    if (part.done) throw new Error("gateway process exited before listening")
    text += Buffer.from(part.value).toString()
  }
  reader.releaseLock()
  const port = Number(/^listening (\d+)$/m.exec(text)?.[1])
  return {
    port,
    stop: async () => {
      child.kill("SIGKILL")
      await child.exited
    },
  }
}

/** The same server in this process, so its routes count toward the plain run's coverage. */
async function inProcessGateway(f: Fixture) {
  const scope = Effect.runSync(Scope.make())
  const served = await Effect.runPromise(
    serveCapabilityGateway(f.env, { keys: async () => jwks, upstream: f.upstreamFn }).pipe(
      Scope.provide(scope),
    ),
  )
  return {
    port: served.port,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

async function scenario(start: (f: Fixture) => Promise<{ port: number; stop(): Promise<void> }>) {
  const f = await fixture()
  let gateway = await start(f)
  try {
    const url = (path: string) => `http://127.0.0.1:${gateway.port}${path}`
    const session = (token: string, signal?: AbortSignal) =>
      fetch(url("/capabilities/v1/session"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        ...(signal ? { signal } : {}),
      })
    const call = (token: string) =>
      fetch(url("/capabilities/v1/providers/anthropic/v1/messages"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: JSON.stringify({ model: "fixture-model", stream: true, messages: [] }),
      })

    expect((await fetch(url("/capabilities/v1/challenge?lease=other"))).status).toBe(403)
    expect((await fetch(url("/capabilities/v1/challenge?lease=lease&x=1"))).status).toBe(403)
    const challenged = await fetch(url("/capabilities/v1/challenge?lease=lease"))
    expect(challenged.status).toBe(200)
    expect(challenged.headers.get("cache-control")).toBe("no-store")
    const challenge = await Challenge(challenged)
    const audience = `workflowd:${challenge.channel}:${challenge.nonce}`

    // Another Actions run's proof for this challenge, and malformed proofs, consume nothing.
    expect((await session(proof(audience, "jti-1", { run_id: "79" }))).status).toBe(403)
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

    // A session request cut while its run token is minted consumes neither challenge nor jti.
    await writeFile(join(f.root, "slow"), "")
    const cut = new AbortController()
    const interrupted = session(proof(audience, "jti-1"), cut.signal).catch(() => "aborted")
    await Bun.sleep(300)
    cut.abort()
    expect(await interrupted).toBe("aborted")
    await rm(join(f.root, "slow"))

    const granted = await session(proof(audience, "jti-1"))
    expect(granted.status).toBe(200)
    const grant = await Grant(granted)
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(grant.renewAt).toBeLessThanOrEqual(grant.deadline)

    // The same jti, or a new challenge for a bound lease, is refused.
    expect((await session(proof(audience, "jti-1"))).status).toBe(403)
    expect((await fetch(url("/capabilities/v1/challenge?lease=lease"))).status).toBe(403)

    const first = await call(grant.token)
    expect(first.status).toBe(200)
    expect(await first.text()).toBe(sse)
    expect((await call("x".repeat(43))).status).toBe(403)

    const renewed = await fetch(url("/capabilities/v1/renew"), {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(renewed.status).toBe(200)
    const next = await Renewed(renewed)
    expect(next.token).not.toBe(grant.token)
    expect(await (await call(next.token)).text()).toBe(sse)

    // The gateway restarts; the run's next call succeeds on the same binding.
    await gateway.stop()
    gateway = await start(f)
    expect(await (await call(next.token)).text()).toBe(sse)

    // workflowd builds its own gateway on the same store when it starts; that revokes nothing.
    await f.store(makeCapabilityGateway(f.config).pipe(Effect.andThen(Effect.sleep("10 millis"))))
    expect(await (await call(next.token)).text()).toBe(sse)

    // A revoke written by another process aborts a live stream.
    f.setStall(true)
    const live = await call(next.token)
    expect(live.status).toBe(200)
    const reader = live.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await f.store(
      Effect.gen(function* () {
        yield* (yield* makeCapabilityStore).revoke("run")
      }),
    )
    const ended = await Promise.race([
      reader.read().then(
        () => "ended",
        () => "ended",
      ),
      Bun.sleep(5000).then(() => "live"),
    ])
    expect(ended).toBe("ended")
    expect((await call(next.token)).status).toBe(403)
  } finally {
    await gateway.stop()
    await f.close()
  }
}

test("the gateway process binds a run by OIDC session and keeps it across restarts", async () => {
  await scenario(processGateway)
}, 60000)

test("the gateway server in this process serves the same session API", async () => {
  await scenario(inProcessGateway)
}, 60000)

test("the gateway process refuses to start without its configuration", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(serveCapabilityGateway({ WORKFLOWD_DATABASE_PATH: ":memory:" })),
  )
  expect(Exit.isFailure(exit)).toBe(true)
})
