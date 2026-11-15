import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Exit, Schema, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { serveCapabilityGateway } from "../../src/capability-gateway-server"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { seedCapabilityRun } from "./fixture"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
export const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }],
}

/**
 * A GitHub Actions OIDC proof for a lease of the fixture repository (Actions run 78, attempt 1,
 * unless `claims` names others). `header` adds header fields; `issuedAt` sets `iat` and `nbf`
 * (seconds since the epoch), five seconds ago unless named.
 */
export const proof = (
  audience: string,
  jti: string,
  options: {
    readonly lease?: string
    readonly claims?: Record<string, string | number>
    readonly header?: Record<string, string>
    readonly issuedAt?: number
  } = {},
) => {
  const now = Math.floor(Date.now() / 1000)
  const issued = options.issuedAt ?? now - 5
  const ref = `refs/heads/workflowd/leases/${options.lease ?? "lease"}`
  const input = [
    { alg: "RS256", typ: "JWT", kid: "fixture", ...options.header },
    {
      iss: "https://token.actions.githubusercontent.com",
      aud: audience,
      sub: `repo:fixture@1/repo@12:ref:${ref}`,
      jti,
      iat: issued,
      nbf: issued,
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
      ...options.claims,
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".")
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
}

const event = (type: string, value: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
/** A complete Anthropic message stream, so a real client finishes its call on it. */
export const sse =
  event("message_start", {
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }) +
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
  event("content_block_stop", { index: 0 }) +
  event("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  }) +
  event("message_stop", {})

/** A request that reached the model upstream: its path and query, headers and body text. */
export interface UpstreamRequest {
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * A store, a noscope configuration and the servers a gateway reaches: a key server and a model
 * upstream, each in this process. The run token provider records each start in `mints`, the
 * most it saw running at once in `peaks`, waits while `slow` exists, and gives a token that
 * lives `ttl` seconds when that file names fewer than asked. The model upstream records each
 * request it receives.
 */
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wfd-gateway-process-"))
  await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
  await mkdir(join(root, "live"))
  await writeFile(
    join(root, "run.mjs"),
    `import {existsSync,readFileSync,appendFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
const root=${JSON.stringify(root)};
appendFileSync(root+'/mints','start\\n');
writeFileSync(root+'/live/'+process.pid,'');
appendFileSync(root+'/peaks',readdirSync(root+'/live').length+'\\n');
try {
  while (existsSync(root+'/slow')) await new Promise((r)=>setTimeout(r,50));
  const asked=Number(process.argv[2]);
  const ttl=existsSync(root+'/ttl')?Math.min(asked,Number(readFileSync(root+'/ttl','utf8'))):asked;
  process.stdout.write(JSON.stringify({token:randomBytes(32).toString('base64url'),token_id:randomUUID(),expires_at:new Date(Date.now()+ttl*1000).toISOString()}));
} finally { rmSync(root+'/live/'+process.pid,{force:true}) }`,
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
  const received: UpstreamRequest[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      received.push({
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
      return new Response(
        stall
          ? new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"))
              },
            })
          : sse,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  let keyFetches = 0
  const keyServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      keyFetches++
      return Response.json(jwks)
    },
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
  await store(seedCapabilityRun(Date.now(), true))
  const lines = async (name: string) =>
    (await readFile(join(root, name), "utf8").catch(() => "")).split("\n").filter(Boolean)
  return {
    root,
    env,
    config,
    store,
    keysUrl: `http://127.0.0.1:${keyServer.port}/`,
    upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    keyFetches: () => keyFetches,
    mints: async () => (await lines("mints")).length,
    peakMints: async () => Math.max(0, ...(await lines("peaks")).map(Number)),
    liveMints: async () => (await readdir(join(root, "live"))).length,
    slowMints: async (slow: boolean) =>
      slow ? writeFile(join(root, "slow"), "") : rm(join(root, "slow"), { force: true }),
    tokenSeconds: (seconds: number | null) =>
      seconds === null
        ? rm(join(root, "ttl"), { force: true })
        : writeFile(join(root, "ttl"), String(seconds)),
    /** Each request that reached the model upstream, in order. */
    upstreamRequests: (): ReadonlyArray<UpstreamRequest> => received,
    setStall: (value: boolean) => {
      stall = value
    },
    sql: <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
      store(
        Effect.gen(function* () {
          return yield* query(yield* SqlClient.SqlClient)
        }),
      ),
    close: async () => {
      await upstream.stop(true)
      await keyServer.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>
export interface Gateway {
  readonly port: number
  stop(): Promise<void>
}

/** The gateway as its own process: its real entry and network listener, with the fixture's servers. */
export async function processGateway(f: Fixture): Promise<Gateway> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { runCapabilityGatewayServer } from ${JSON.stringify(resolve("src/capability-gateway-server.ts"))}
import { Effect } from "effect"
Effect.runFork(runCapabilityGatewayServer(process.env, {
  keys: async (signal) => (await fetch(${JSON.stringify(f.keysUrl)}, { signal })).json(),
  upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", ${JSON.stringify(f.upstreamUrl)}), init),
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
  return {
    port: Number(/^listening (\d+)$/m.exec(text)?.[1]),
    stop: async () => {
      child.kill("SIGKILL")
      await child.exited
    },
  }
}

/** The same server and listener in this process, so its routes count toward coverage. */
export async function inProcessGateway(f: Fixture): Promise<Gateway> {
  const scope = Effect.runSync(Scope.make())
  const served = await Effect.runPromise(
    serveCapabilityGateway(f.env, {
      keys: async (signal) => (await fetch(f.keysUrl, { signal })).json(),
      upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", f.upstreamUrl), init),
    }).pipe(Scope.provide(scope)),
  )
  return { port: served.port, stop: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

export const gateways = [
  ["process", processGateway],
  ["in-process", inProcessGateway],
] as const

/**
 * Another run and lease of the fixture repository beside the seeded one. Its Actions run is
 * `actionsRunId`, attempt 1, or none yet when it is null. The lease was requested at
 * `requestedAt`, so its deadline is 285 minutes after that.
 */
export const seedLease = (
  runId: string,
  leaseId: string,
  actionsRunId: number | null,
  native = true,
  requestedAt = Date.now(),
) =>
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
      now: requestedAt,
    })
    yield* leases.beginStart(runId)
    if (actionsRunId !== null) yield* leases.recordRun(runId, actionsRunId, 1)
  })

/** The runner's and the relay's requests to a gateway on `port`. */
export const client = (port: number) => {
  const url = (path: string) => `http://127.0.0.1:${port}${path}`
  const challenge = (lease = "lease") => fetch(url(`/capabilities/v1/challenge?lease=${lease}`))
  const audience = async (lease = "lease") => {
    const issued = await challenge(lease)
    if (issued.status !== 200) throw new Error(`challenge answered ${issued.status}`)
    const value = Schema.decodeUnknownSync(
      Schema.Struct({ channel: Schema.String, nonce: Schema.String, expiresAt: Schema.Number }),
    )(await issued.json())
    return { ...value, audience: `workflowd:${value.channel}:${value.nonce}` }
  }
  const session = (token: string) =>
    fetch(url("/capabilities/v1/session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
  const grant = async (response: Response) =>
    Schema.decodeUnknownSync(
      Schema.Struct({
        token: Schema.String,
        expiresAt: Schema.Number,
        renewAt: Schema.Number,
        deadline: Schema.optionalKey(Schema.Number),
      }),
    )(await response.json())
  /** A Claude messages call with `body` as its exact text; `headers` add to or replace the usual. */
  const provider = (token: string, body: string, headers: Record<string, string> = {}) =>
    fetch(url("/capabilities/v1/providers/anthropic/v1/messages"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        ...headers,
      },
      body,
    })
  const call = (token: string) =>
    provider(token, JSON.stringify({ model: "fixture-model", stream: true, messages: [] }))
  const renew = (token: string) =>
    fetch(url("/capabilities/v1/renew"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    })
  return { url, challenge, audience, session, grant, provider, call, renew }
}

/** Starts a gateway with `start`, runs `body` against it, and always stops both. */
export async function withGateway(
  start: (f: Fixture) => Promise<Gateway>,
  body: (f: Fixture, gateway: Gateway) => Promise<void>,
) {
  const f = await fixture()
  let gateway: Gateway | undefined
  try {
    gateway = await start(f)
    await body(f, gateway)
  } finally {
    await gateway?.stop()
    await f.close()
  }
}
