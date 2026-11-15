import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { connect } from "node:net"
import { Effect, Exit, Schema, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { capabilityDigest, makeCapabilityStore } from "../../src/capability-gateway/store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeSandboxStore } from "../../src/sandbox/store"
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
  Schema.Struct({
    token: Schema.String,
    expiresAt: Schema.Number,
    renewAt: Schema.Number,
    deadline: Schema.Number,
  }),
)
const Renewed = json(Schema.Struct({ token: Schema.String, renewAt: Schema.Number }))
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

/** Another run and lease beside the fixture's, for Actions run `actionsRunId`, attempt 1. */
const seedLease = (runId: string, leaseId: string, actionsRunId: number, native: boolean) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    yield* runs.create({
      runId,
      route: "fixture",
      providerId: "anthropic",
      modelId: "fixture-model",
      executorKind: "claude",
      agent: "sandbox",
      repository: "fixture",
      directory: "/fixture",
      prompt: "fixture",
      promptSha256: "c".repeat(64),
      parentSessionId: null,
      resumePrompt: null,
      maxAttempts: 1,
      createdAt: new Date(),
    })
    yield* runs.claimSpawn({ runId, now: new Date() })
    const leases = yield* makeSandboxStore
    yield* leases.request({
      runId,
      leaseId,
      policy: {
        ...(native
          ? { privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 } }
          : {}),
        alias: "fixture",
        repository: "fixture/repo",
        repositoryId: 12,
        installationId: 1,
        workflowSha: "a".repeat(40),
        appActorId: 56,
        agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
        tailscaleClientId: "fixture",
        tailscaleAudience: "fixture",
      },
      sourceSha: "d".repeat(40),
      now: Date.now(),
    })
    yield* leases.beginStart(runId)
    yield* leases.recordRun(runId, actionsRunId, 1)
  })

const ended = (reader: { read(): Promise<unknown> }, within: number) =>
  Promise.race([
    reader.read().then(
      () => "ended",
      () => "ended",
    ),
    Bun.sleep(within).then(() => "live"),
  ])

async function scenario(start: (f: Fixture) => Promise<{ port: number; stop(): Promise<void> }>) {
  const f = await fixture()
  await f.store(
    Effect.gen(function* () {
      yield* seedLease("run-b", "lease-b", 79, true)
      yield* seedLease("run-c", "lease-c", 80, true)
      yield* seedLease("run-d", "lease-d", 81, false)
    }),
  )
  let gateway = await start(f)
  let other: { port: number; stop(): Promise<void> } | undefined
  try {
    const url = (path: string, port = gateway.port) => `http://127.0.0.1:${port}${path}`
    const challenge = (lease: string, port?: number) =>
      fetch(url(`/capabilities/v1/challenge?lease=${lease}`, port))
    const audienceOf = async (lease: string, port?: number) => {
      const issued = await challenge(lease, port)
      expect(issued.status).toBe(200)
      expect(issued.headers.get("cache-control")).toBe("no-store")
      const value = await Challenge(issued)
      return `workflowd:${value.channel}:${value.nonce}`
    }
    const session = (token: string, port?: number) =>
      fetch(url("/capabilities/v1/session", port), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
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
    const renew = (token: string) =>
      fetch(url("/capabilities/v1/renew"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      })
    const sessionOfRun = () =>
      f.store(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
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
    expect((await session(proof(first, "jti-1", { run_id: "79" }))).status).toBe(403)
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
    await writeFile(join(f.root, "slow"), "")
    const body = JSON.stringify({ token: proof(first, "jti-1") })
    const socket = connect(gateway.port, "127.0.0.1")
    let answered = ""
    socket.on("data", (bytes) => (answered += bytes.toString()))
    socket.write(
      `POST /capabilities/v1/session HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
    await Bun.sleep(300)
    socket.destroy()
    expect(answered).toBe("")
    await rm(join(f.root, "slow"))
    for (let tries = 0; (await sessionOfRun()) !== 1 && tries < 100; tries++) await Bun.sleep(50)
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
    await f.store(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE capability_tokens SET expires_at=${Date.now() + 300000}
          WHERE digest=${capabilityDigest(grant.token)}`
      }),
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

    // workflowd builds its own gateway on the same store when it starts; that revokes nothing.
    await f.store(makeCapabilityGateway(f.config).pipe(Effect.andThen(Effect.sleep("10 millis"))))
    expect(await (await call(next.token)).text()).toBe(sse)

    // (e) A new session, opened through another gateway on the same store, ends a live stream
    // on the earlier session's token.
    f.setStall(true)
    const live = await call(next.token)
    expect(live.status).toBe(200)
    const reader = live.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    other = await start(f)
    const third = await session(proof(await audienceOf("lease", other.port), "jti-3"), other.port)
    expect(third.status).toBe(200)
    const current = await Grant(third)
    expect(await ended(reader, 2000)).toBe("ended")
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
    expect((await challenge("lease-b")).status).toBe(403)
    expect((await challenge("lease-c")).status).toBe(403)

    // A revoke written by another process aborts a live stream.
    f.setStall(true)
    const stream = await call(current.token)
    expect(stream.status).toBe(200)
    const streamed = stream.body!.getReader()
    expect((await streamed.read()).done).toBe(false)
    await f.store(
      Effect.gen(function* () {
        yield* (yield* makeCapabilityStore).revoke("run")
      }),
    )
    expect(await ended(streamed, 5000)).toBe("ended")
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
  expect(Exit.isFailure(exit)).toBe(true)
})
