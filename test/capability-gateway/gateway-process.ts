import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
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
import { makeDaemonCapability, type DaemonCapability } from "../../src/sandbox/capability-control"

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
 * workflowd's store and the gateway's, as two files; a noscope configuration and the servers a
 * gateway reaches: a key server and a model upstream, each in this process. `daemon` runs
 * workflowd's side of the control socket on workflowd's store. The run token provider records each start in `mints`, the
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
  let onUpstream: ((request: Request) => Promise<void>) | undefined
  const received: UpstreamRequest[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      await onUpstream?.(request)
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
  const controlSocket = join(root, "control", "gateway.sock")
  const config = {
    nodeBinary: fixtureExecutable("node"),
    noscope: { binary: fixtureExecutable("noscope"), configHome: root },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 8,
    maxStreamsPerRun: 2,
    storePath: join(root, "gateway.db"),
    controlSocket,
    daemon: { uid: process.getuid!(), gid: process.getgid!() },
    listen: { host: "127.0.0.1", port: 0 },
  }
  const env = {
    PATH: process.env.PATH,
    HOME: root,
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
  await store(seedCapabilityRun(Date.now(), true, undefined, { gatewayStore: false }))
  const lines = async (name: string) =>
    (await readFile(join(root, name), "utf8").catch(() => "")).split("\n").filter(Boolean)
  const daemon = <A, E>(use: (capability: DaemonCapability) => Effect.Effect<A, E>) =>
    store(
      Effect.flatMap(
        makeDaemonCapability({ socket: controlSocket, reconcileEveryMs: 3600000 }),
        use,
      ),
    )
  return {
    root,
    env,
    config,
    store,
    database,
    daemon,
    /** workflowd grants each of its live runs to the gateway and has it revoke the others. */
    reconcile: () => daemon((capability) => capability.reconcile()),
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
    /** Runs before the model upstream records and answers each request. */
    onUpstream: (hook: ((request: Request) => Promise<void>) | undefined) => {
      onUpstream = hook
    },
    /** A query on the gateway's own store, as a test that sets its rows directly needs. */
    gatewaySql: <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`PRAGMA busy_timeout = 5000`
            return yield* query(sql)
          }),
        ).pipe(Effect.provide(SqliteClient.layer({ filename: config.storePath }))),
      ),
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
  /** Each byte the process wrote to standard output and standard error so far. */
  readonly output?: () => string
}

/**
 * The `bun -e` source of a gateway process: the real entry `src/capability-gateway-server.ts`
 * (or `entry`, its path in an image), which reads its configuration from the environment, with
 * the job keys of the fixture key server at `keysUrl` and the model upstream at `upstreamUrl` in
 * place of api.anthropic.com.
 */
export const gatewaySource = (
  servers: { readonly keysUrl: string; readonly upstreamUrl: string },
  entry = resolve("src/capability-gateway-server.ts"),
) =>
  `import { runCapabilityGatewayServer } from ${JSON.stringify(entry)}
import { Cause, Effect } from "effect"
Effect.runFork(runCapabilityGatewayServer(process.env, {
  keys: async (signal) => (await fetch(${JSON.stringify(servers.keysUrl)}, { signal })).json(),
  upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", ${JSON.stringify(servers.upstreamUrl)}), init),
}).pipe(Effect.tapCause((cause) => Effect.sync(() => process.stderr.write(Cause.pretty(cause) + "\\n")))))`

/**
 * Starts a gateway process from `argv` and `env`, in the repository root, and returns once its
 * standard output has given the line `listening <port>`. It fails, and leaves no process, when
 * the process ends first. `stop` kills the process and waits for its end.
 */
export async function startGatewayProcess(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Gateway> {
  const child = Bun.spawn([...argv], {
    cwd: resolve("."),
    env: { ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  let errors = ""
  const forwarded = (async () => {
    for await (const chunk of child.stderr) {
      errors += Buffer.from(chunk).toString()
      process.stderr.write(chunk)
    }
  })()
  const stop = async () => {
    child.kill("SIGKILL")
    await child.exited
    await forwarded
  }
  const reader = child.stdout.getReader()
  let text = ""
  let port: number | undefined
  try {
    while (port === undefined) {
      const part = await reader.read()
      if (part.done) {
        await forwarded
        throw new Error(`gateway process exited before listening: ${text}${errors}`)
      }
      text += Buffer.from(part.value).toString()
      const listening = /^listening (\d+)\n/m.exec(text)?.[1]
      if (listening !== undefined) port = Number(listening)
    }
  } catch (error) {
    await stop()
    throw error
  } finally {
    reader.releaseLock()
  }
  void (async () => {
    for await (const chunk of child.stdout) text += Buffer.from(chunk).toString()
  })()
  return { port, stop, output: () => text + errors }
}

/**
 * The gateway as its own process: its real entry and network listener, with the fixture's servers.
 * Once it listens, workflowd's side grants its live runs on the control socket.
 */
export async function processGateway(f: Fixture): Promise<Gateway> {
  const gateway = await startGatewayProcess([process.execPath, "-e", gatewaySource(f)], f.env)
  await f.reconcile().catch(async (error: unknown) => {
    await gateway.stop()
    throw error
  })
  return gateway
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
  const stop = () => Effect.runPromise(Scope.close(scope, Exit.void))
  await f.reconcile().catch(async (error: unknown) => {
    await stop()
    throw error
  })
  return { port: served.port, stop }
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

/** A synthetic login of Claude, as Claude Code's credentials file holds it. */
export const claudeLogin = (access: string, refresh: string, expiresAt: number) => ({
  claudeAiOauth: {
    accessToken: access,
    refreshToken: refresh,
    expiresAt,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "fixture",
  },
})

/** A synthetic value that no real login holds. */
export const syntheticValue = (kind: string) =>
  `synthetic-${kind}-${randomBytes(18).toString("hex")}`

/** A request that reached the fixture OAuth server: its body, and when it arrived. */
export interface OAuthRequest {
  readonly body: string
  readonly at: number
}

/**
 * A fixture OAuth server on loopback, a real HTTP server in this process. In `renew` it answers a
 * refresh with `next` (an access value that lives an hour, and a new refresh value). In `refuse`
 * it answers 400 `invalid_grant`, in `busy` 503, and in `garbled` a body that does not parse.
 * In `silent` it never answers. In `cut` it sends the status and
 * part of the body, calls `onCut`, and never sends the rest.
 */
export function oauthFixture() {
  let mode: "renew" | "refuse" | "silent" | "cut" | "busy" | "garbled" = "renew"
  let next = { access: syntheticValue("access"), refresh: syntheticValue("refresh") }
  let onCut: (() => void) | undefined
  const requests: OAuthRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      requests.push({ body: await request.text(), at: performance.now() })
      if (mode === "refuse") return Response.json({ error: "invalid_grant" }, { status: 400 })
      if (mode === "silent") return new Promise<Response>(() => {})
      if (mode === "busy") return new Response(null, { status: 503 })
      if (mode === "garbled") return new Response("{not json")
      const body = JSON.stringify({
        token_type: "Bearer",
        access_token: next.access,
        refresh_token: next.refresh,
        expires_in: 3600,
        scope: "user:inference user:profile",
      })
      if (mode === "renew") return Response.json(JSON.parse(body))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body.slice(0, 40)))
            setTimeout(() => onCut?.(), 50)
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1/oauth/token`,
    requests: (): ReadonlyArray<OAuthRequest> => requests,
    mode: (value: typeof mode, cut?: () => void) => {
      mode = value
      onCut = cut
    },
    /** The values the next renewal gives. */
    next: () => next,
    renewWith: (value: { access: string; refresh: string }) => {
      next = value
    },
    stop: () => server.stop(true),
  }
}
export type OAuthFixture = ReturnType<typeof oauthFixture>

/**
 * The noscope provider `provider-access` as custody serves it, for the login in `directory`,
 * renewed against `tokenUrl`. `bun` and `source` are the paths of an image when it runs there.
 */
export async function writeCustodyProvider(
  root: string,
  directory: string,
  tokenUrl: string,
  bun = process.execPath,
  source = resolve("src/capability-gateway/custody.ts"),
) {
  await writeFile(
    join(root, "noscope/providers/provider-access.toml"),
    `contract_version = 1\n[commands]\nmint = "${bun} ${source} access ${directory} --token-url ${tokenUrl} {role} {ttl}"\n`,
    { mode: 0o600 },
  )
}

/** The gateway's configuration of a fixture with custody of the Claude login in `directory`. */
export const custodyEnv = (f: Fixture, directory: string) => ({
  ...f.env,
  WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
    ...f.config,
    credentialRole: "claude",
    login: { directory },
  }),
})

/** The gateway's `import-login` command, with `input` on its standard input. */
export async function importLogin(
  env: Readonly<Record<string, string | undefined>>,
  input: string,
  args: ReadonlyArray<string> = ["claude"],
) {
  const child = Bun.spawn(
    [process.execPath, resolve("src/capability-gateway-server.ts"), "import-login", ...args],
    { cwd: resolve("."), env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  child.stdin.write(input)
  await child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

/** The access value of a stored Claude login, from the text of its file. */
export const storedAccess = (text: string) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({ claudeAiOauth: Schema.Struct({ accessToken: Schema.String }) }),
    ),
  )(text).claudeAiOauth.accessToken
