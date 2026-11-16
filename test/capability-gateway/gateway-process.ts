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
import { loopbackCertificate, tlsFront } from "../helpers/loopback-tls"
import { seedCapabilityRun, writeNoscopeProvider } from "./fixture"
import { makeDaemonCapability, type DaemonCapability } from "../../src/sandbox/capability-control"
import { capabilityDigest } from "../../src/capability-gateway/store"
import { sessionBinder, sessionKeyPair, signRenewal } from "../../deploy/sandbox/renewal.mjs"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
/** The private key of `jwks`: it signs the fixture's job proofs. */
export const signingKey = privateKey
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

/** Keys of the gateway config that a test sets for its gateway. */
interface GatewayKeys {
  readonly maxStreamsPerRun?: number
  readonly streamIdleMs?: number
}

/** The fixed event stream, one event and then silence, or `chunks` events `gapMs` apart. */
type UpstreamAnswer =
  | "events"
  | "stall"
  | { readonly chunks: number; readonly gapMs: number }
  | { readonly text: string }

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
 * request it receives. `keys` add to or replace keys of the gateway config. The key server and
 * the upstream listen on `host`: loopback, unless a gateway in a container reaches them there.
 */
export async function fixture(keys: GatewayKeys = {}, host = "127.0.0.1") {
  const root = await mkdtemp(join(tmpdir(), "wfd-gateway-process-"))
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
  await writeNoscopeProvider(root, "run-capability", [
    process.execPath,
    join(root, "run.mjs"),
    "{ttl}",
  ])
  await writeNoscopeProvider(root, "provider-access", [process.execPath, join(root, "access.mjs")])
  let onUpstream: ((request: Request) => Promise<void>) | undefined
  let answer: UpstreamAnswer = "events"
  let cancelled = 0
  const received: UpstreamRequest[] = []
  const upstream = Bun.serve({
    hostname: host,
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      await onUpstream?.(request)
      received.push({
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
      if (answer === "events")
        return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      if (typeof answer === "object" && "text" in answer)
        return new Response(answer.text, { headers: { "content-type": "text/event-stream" } })
      const ends = answer !== "stall"
      const { chunks, gapMs } = answer === "stall" ? { chunks: 1, gapMs: 0 } : answer
      let timer: ReturnType<typeof setTimeout> | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let sent = 0
            const tick = () => {
              if (sent === chunks) {
                if (ends) controller.close()
                return
              }
              const event = ends
                ? `event: ping\ndata: ${sent}\n\n`
                : "event: message_start\ndata: {}\n\n"
              sent++
              controller.enqueue(new TextEncoder().encode(event))
              timer = setTimeout(tick, gapMs)
            }
            tick()
          },
          cancel() {
            clearTimeout(timer)
            cancelled++
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  let keyFetches = 0
  const keyServer = Bun.serve({
    hostname: host,
    port: 0,
    fetch: () => {
      keyFetches++
      return Response.json(jwks)
    },
  })
  const database = join(root, "workflowd.db")
  const controlSocket = join(root, "control", "gateway.sock")
  const listenSocket = join(root, "front", "gateway.sock")
  const tls = await loopbackCertificate(root)
  const front = await tlsFront(tls, listenSocket)
  const config = {
    noscope: { binary: fixtureExecutable("noscope"), configHome: root },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 8,
    maxStreamsPerRun: 2,
    storePath: join(root, "gateway.db"),
    controlSocket,
    daemon: { uid: process.getuid!(), gid: process.getgid!() },
    listen: {
      socket: listenSocket,
      front: { uid: process.getuid!(), gid: process.getgid!() },
      service: front.service,
    },
    ...keys,
  }
  // A gateway process makes its private directory below TMPDIR: here, in the fixture.
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
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
    /** The gateway's front, through which each runner reaches it, and the front's certificate. */
    front,
    tls,
    store,
    database,
    daemon,
    /** workflowd grants each of its live runs to the gateway and has it revoke the others. */
    reconcile: () => daemon((capability) => capability.reconcile()),
    keysUrl: `http://${host}:${keyServer.port}/`,
    upstreamUrl: `http://${host}:${upstream.port}`,
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
    /** The upstream answers with one event and then nothing, until set back. */
    setStall: (value: boolean) => {
      answer = value ? "stall" : "events"
    },
    /** The upstream answers with `chunks` events `gapMs` apart, then ends. */
    setTrickle: (chunks: number, gapMs: number) => {
      answer = { chunks, gapMs }
    },
    /** The upstream answers with `text` as its whole event stream. */
    setAnswerText: (text: string) => {
      answer = { text }
    },
    /** How many upstream answers the gateway cancelled before their end. */
    upstreamCancels: () => cancelled,
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
      front.close()
      await upstream.stop(true)
      await keyServer.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>
/** Where a runner reaches a gateway: the origin of its front, and the front's certificate. */
export interface Origin {
  readonly origin: string
  readonly ca: string
}
export interface Gateway extends Origin {
  stop(): Promise<void>
  /** Sends SIGTERM, the stop of a service manager, and waits for the end of the process. */
  readonly terminate?: () => Promise<void>
  /** The listener's socket, as the process named it. */
  readonly socket?: string
  /** The id of the process. */
  readonly pid?: number
  /** Each byte the process wrote to standard output and standard error so far. */
  readonly output?: () => string
}

/**
 * The `bun -e` source of a gateway process: the server of `src/capability-gateway-server.ts`
 * (or `entry`, its path in an image), which reads its configuration from the environment, with
 * the job keys of the fixture key server at `keysUrl` and the model upstream at `upstreamUrl` in
 * place of api.anthropic.com. It prints its listener's socket and ends on SIGTERM as the process
 * entry does.
 */
export const gatewaySource = (
  servers: { readonly keysUrl: string; readonly upstreamUrl: string },
  entry = resolve("src/capability-gateway-server.ts"),
) =>
  `import { serveCapabilityGateway } from ${JSON.stringify(entry)}
import { BunRuntime } from "@effect/platform-bun"
import { Cause, Effect } from "effect"
BunRuntime.runMain(serveCapabilityGateway(process.env, {
  keys: async (signal) => (await fetch(${JSON.stringify(servers.keysUrl)}, { signal })).json(),
  upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", ${JSON.stringify(servers.upstreamUrl)}), init),
}).pipe(
  Effect.tap(({ socket }) => Effect.sync(() => process.stdout.write(\`listening \${socket}\\n\`))),
  Effect.andThen(Effect.never),
  Effect.scoped,
  Effect.tapCause((cause) => Effect.sync(() => process.stderr.write(Cause.pretty(cause) + "\\n"))),
), { disableErrorReporting: true })`

/**
 * Starts a gateway process from `argv` and `env`, in the repository root, and returns once its
 * standard output has given the line `listening <socket>`; a runner reaches it through `front`.
 * It fails, and leaves no process, when the process ends first. `stop` kills the process and
 * waits for its end.
 */
export async function startGatewayProcess(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  front: Origin,
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
  let socket: string | undefined
  try {
    while (socket === undefined) {
      const part = await reader.read()
      if (part.done) {
        await forwarded
        throw new Error(`gateway process exited before listening: ${text}${errors}`)
      }
      text += Buffer.from(part.value).toString()
      socket = /^listening (\/\S+)\n/m.exec(text)?.[1]
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
  const terminate = async () => {
    child.kill("SIGTERM")
    await child.exited
    await forwarded
  }
  return {
    origin: front.origin,
    ca: front.ca,
    socket,
    stop,
    terminate,
    pid: child.pid,
    output: () => text + errors,
  }
}

/**
 * The gateway as its own process: its real entry and listener, with the fixture's servers.
 * Once it listens, workflowd's side grants its live runs on the control socket.
 */
export async function processGateway(f: Fixture): Promise<Gateway> {
  const gateway = await startGatewayProcess(
    [process.execPath, "-e", gatewaySource(f)],
    f.env,
    f.front,
  )
  await f.reconcile().catch(async (error: unknown) => {
    await gateway.stop()
    throw error
  })
  return gateway
}

/** The same server and listener in this process, so its routes count toward coverage. */
export async function inProcessGateway(f: Fixture): Promise<Gateway> {
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
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
  return { origin: f.front.origin, ca: f.front.ca, stop }
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

/** The session key of the fixture's runner: each client signs with it unless it names another. */
export const runnerKey = sessionKeyPair()

/**
 * The runner's and the relay's requests to a gateway, through its front at `at`. The client holds
 * the session key `key`: its proofs bind the public key, and its renewals are signed with it.
 */
export const client = (at: Origin, key: { publicKey: string; privateKey: string } = runnerKey) => {
  const url = (path: string) => `${at.origin}${path}`
  /** A request to `path` of the gateway, through its front. */
  const request = (path: string, init: RequestInit = {}) =>
    fetch(url(path), { ...init, tls: { ca: at.ca } })
  const challenge = (lease = "lease") => request(`/capabilities/v1/challenge?lease=${lease}`)
  const audience = async (lease = "lease") => {
    const issued = await challenge(lease)
    if (issued.status !== 200) throw new Error(`challenge answered ${issued.status}`)
    const value = Schema.decodeUnknownSync(
      Schema.Struct({ channel: Schema.String, nonce: Schema.String, expiresAt: Schema.Number }),
    )(await issued.json())
    return {
      ...value,
      audience: `workflowd:${value.channel}:${sessionBinder(value.nonce, key.publicKey)}`,
    }
  }
  /** Posts the proof `token` with the public session key `publicKey`, the client's unless named. */
  const session = (token: string, publicKey: string = key.publicKey) =>
    request("/capabilities/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, key: publicKey }),
    })
  const grant = async (response: Response) =>
    Schema.decodeUnknownSync(
      Schema.Struct({
        token: Schema.String,
        expiresAt: Schema.Number,
        renewAt: Schema.Number,
        deadline: Schema.optionalKey(Schema.Number),
        providerId: Schema.optionalKey(Schema.String),
      }),
    )(await response.json())
  /** A Claude messages call with `body` as its exact text; `headers` add to or replace the usual. */
  const provider = (token: string, body: string, headers: Record<string, string> = {}) =>
    request("/capabilities/v1/providers/anthropic/v1/messages", {
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
  /** A renewal of `token` whose body is `body`, as its exact text. */
  const renewWith = (token: string, body: string) =>
    request("/capabilities/v1/renew", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    })
  /** The relay's renewal of `token` on the run's `channel`, signed with the client's key. */
  const renew = (token: string, channel: string) =>
    renewWith(
      token,
      JSON.stringify({
        signature: signRenewal(key.privateKey, channel, capabilityDigest(token)),
      }),
    )
  return { url, request, challenge, audience, session, grant, provider, call, renew, renewWith }
}

/** Starts a gateway with `start` and the config `keys`, runs `body` against it, and always stops both. */
export async function withGateway(
  start: (f: Fixture) => Promise<Gateway>,
  body: (f: Fixture, gateway: Gateway) => Promise<void>,
  keys: GatewayKeys = {},
) {
  const f = await fixture(keys)
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

/** The refresh value that a request to the fixture OAuth server sent. */
export const sentRefresh = (request: OAuthRequest | undefined) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ refresh_token: Schema.String })))(
    request?.body ?? "{}",
  ).refresh_token

/** Claude Code's public OAuth client id, the only one the fixture OAuth server takes. */
export const claudeClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * A fixture OAuth server on `host`, loopback unless named, a real HTTP server in this process. It reads the request
 * as JSON and answers 401 `invalid_client` to any client id but Claude Code's. Else, in `renew`
 * it answers a refresh with `next` (an access value that lives an hour, and a new refresh value),
 * with no `scope` field in `unscoped` and the scope `user:profile` alone in `narrow`. In `refuse`
 * it answers 400 `invalid_grant`, in `invalid` 400 `invalid_request`, in `busy` 503, in `limited`
 * 429 with `Retry-After` of `retryAfter` seconds, and in `garbled` a body that does not parse. In
 * `silent` it never answers. In `hold` it answers as `renew` once `release` is called. In `cut`
 * it sends the status and part of the body, calls `onCut`, and never sends the rest.
 */
export function oauthFixture(host = "127.0.0.1") {
  type Mode =
    | "renew"
    | "unscoped"
    | "narrow"
    | "refuse"
    | "invalid"
    | "silent"
    | "hold"
    | "cut"
    | "busy"
    | "limited"
    | "garbled"
  let mode: Mode = "renew"
  let retryAfter = 0
  let next = { access: syntheticValue("access"), refresh: syntheticValue("refresh") }
  let onCut: (() => void) | undefined
  let released = Promise.withResolvers<void>()
  const requests: OAuthRequest[] = []
  const server = Bun.serve({
    hostname: host,
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const text = await request.text()
      requests.push({ body: text, at: performance.now() })
      const clientId = (() => {
        try {
          const body: unknown = JSON.parse(text)
          return typeof body === "object" && body !== null && "client_id" in body
            ? body.client_id
            : undefined
        } catch {
          return undefined
        }
      })()
      if (clientId !== claudeClientId)
        return Response.json({ error: "invalid_client" }, { status: 401 })
      if (mode === "refuse") return Response.json({ error: "invalid_grant" }, { status: 400 })
      if (mode === "invalid") return Response.json({ error: "invalid_request" }, { status: 400 })
      if (mode === "silent") return new Promise<Response>(() => {})
      if (mode === "busy") return new Response(null, { status: 503 })
      if (mode === "limited")
        return new Response(null, { status: 429, headers: { "retry-after": String(retryAfter) } })
      if (mode === "garbled") return new Response("{not json")
      if (mode === "hold") await released.promise
      const body = JSON.stringify({
        token_type: "Bearer",
        access_token: next.access,
        refresh_token: next.refresh,
        expires_in: 3600,
        ...(mode === "unscoped"
          ? {}
          : { scope: mode === "narrow" ? "user:profile" : "user:inference user:profile" }),
      })
      if (mode !== "cut") return Response.json(JSON.parse(body))
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
    url: `http://${host}:${server.port}/v1/oauth/token`,
    port: server.port,
    requests: (): ReadonlyArray<OAuthRequest> => requests,
    mode: (
      value: Mode,
      options: { readonly cut?: () => void; readonly retryAfter?: number } = {},
    ) => {
      mode = value
      onCut = options.cut
      retryAfter = options.retryAfter ?? 0
      if (value === "hold") released = Promise.withResolvers<void>()
    },
    /** Each held request gets its answer. */
    release: () => released.resolve(),
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

/**
 * "ended" once the stream of `reader` is done or fails within `within` milliseconds, reading
 * past each data chunk; "live" when it has not ended by then.
 */
export async function streamEnd(
  reader: { read(): Promise<{ readonly done: boolean }> },
  within: number,
): Promise<"ended" | "live"> {
  const deadline = Bun.sleep(within).then(() => "live" as const)
  for (;;) {
    const next = await Promise.race([
      reader.read().then(
        (item) => (item.done ? ("ended" as const) : ("chunk" as const)),
        () => "ended" as const,
      ),
      deadline,
    ])
    if (next !== "chunk") return next
  }
}
