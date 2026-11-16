import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import {
  maxEventBatchBytes,
  maxResultManifestBytes,
} from "../../deploy/sandbox/capability-limits.mjs"
import { runSignatureHeader, signRenewal, signRunBody } from "../../deploy/sandbox/renewal.mjs"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeCapabilityStore } from "../../src/capability-gateway/store"
import { runGatewayMigrations } from "../../src/capability-gateway/migrations"
import { serveCapabilityListener } from "../../src/capability-gateway/http"
import { liveGrants } from "../../src/sandbox/capability-control"
import { maxLaunchPromptBytes, RunLaunch } from "../../src/capability-control/protocol"
import { defaultRunBudget } from "../../src/sandbox/config"
import {
  bindRunSession,
  fixtureSessionKey,
  seedCapabilityRun,
  writeNoscopeProviders,
} from "./fixture"

const origin = "http://capability.invalid"
const image = `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`
const identity = { name: "Fixture Agent", email: "agent@example.invalid" }
const launch = { prompt: "fixture prompt", image, identity }

type Gateway = Effect.Success<ReturnType<typeof makeCapabilityGateway>>
type Store = Effect.Success<typeof makeCapabilityStore>
let root: string
let scope: Scope.Closeable
let gateway: Gateway
let store: Store
let sql: SqlClient.SqlClient
let token: string
let channel: string

/** Runs `effect` in the test's one database. */
const inStore = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provideService(effect, SqlClient.SqlClient, sql))

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "run-routes-"))
  await writeNoscopeProviders(root, 120000)
  scope = Effect.runSync(Scope.make())
  // The database lives as long as the test's scope, as the gateway's own store does.
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.provideMerge(AgentRunStoreLive, SqliteClient.layer({ filename: ":memory:" })),
      scope,
    ),
  )
  const built = await Effect.runPromise(
    Effect.gen(function* () {
      // The run is a runner run: its grant carries its launch from the first grant on.
      yield* seedCapabilityRun(Date.now(), true, undefined, { gatewayStore: false })
      yield* runGatewayMigrations
      const store = yield* makeCapabilityStore
      const live = yield* liveGrants(null, Date.now(), defaultRunBudget)
      yield* store.reconcileGrants(live.map((grant) => ({ ...grant, launch })))
      const gateway = yield* makeCapabilityGateway(
        {
          noscope: { binary: fixtureExecutable("noscope"), configHome: root },
          providerId: "anthropic",
          credentialRole: "fixture",
          maxStreams: 1,
          maxStreamsPerRun: 1,
        },
        async () => new Response("fixture upstream is never called", { status: 500 }),
      )
      const session = yield* bindRunSession(Date.now())
      return { gateway, store, session, sql: yield* SqlClient.SqlClient }
    }).pipe(Effect.provide(services), Scope.provide(scope)),
  )
  ;({ gateway, store, sql } = built)
  token = built.session.token
  channel = built.session.binding.channel
})

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await rm(root, { recursive: true, force: true })
})

const call = (
  path: string,
  init: {
    method?: string
    body?: Uint8Array | string
    signature?: string | null
    length?: string
  } = {},
) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.signature != null) headers[runSignatureHeader] = init.signature
  if (init.body !== undefined)
    headers["content-length"] = init.length ?? String(Buffer.byteLength(init.body))
  return Effect.runPromise(
    gateway.handle(
      new Request(`${origin}/capabilities/v1/run/${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    ),
  )
}
const events = (sequence: number, lines: ReadonlyArray<string>) =>
  JSON.stringify({ sequence, lines })
const signed = (route: string, body: Uint8Array | string) =>
  signRunBody(fixtureSessionKey.privateKey, channel, route, body)
const readEvents = (after = 0) => inStore(store.readEvents("run", after))
const framed = (manifest: string, bundle: Uint8Array) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(Buffer.byteLength(manifest))
  return Buffer.concat([head, Buffer.from(manifest), bundle])
}
const usedCalls = async () =>
  (await inStore(sql<{ calls: number }>`SELECT calls FROM capability_usage WHERE run_id='run'`))[0]
    ?.calls

test("the launch answers the run token with the run's prompt, image, identity, model, source, repository and deadline", async () => {
  const response = await call("launch")
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const value: unknown = await response.json()
  expect(value).toEqual({
    prompt: "fixture prompt",
    image,
    identity,
    model: "fixture-model",
    sourceSha: "d".repeat(40),
    repositoryId: 12,
    deadline: expect.any(Number),
  })
  expect((await call("launch", { method: "POST", body: "{}" })).status).toBe(403)
  expect((await call("unknown")).status).toBe(403)
})

test("a request with no run token, or a token that the store does not take, reaches no route", async () => {
  const bare = await Effect.runPromise(
    gateway.handle(new Request(`${origin}/capabilities/v1/run/launch`)),
  )
  expect(bare.status).toBe(403)
  const wrong = await Effect.runPromise(
    gateway.handle(
      new Request(`${origin}/capabilities/v1/run/launch`, {
        headers: { authorization: `Bearer ${"A".repeat(43)}` },
      }),
    ),
  )
  expect(wrong.status).toBe(403)
  expect(await wrong.text()).toBe("")
})

test("an event batch is held only with the session key's signature over its exact body", async () => {
  const first = events(1, ['{"type":"started"}'])
  for (const signature of [
    null,
    "A".repeat(86),
    signed("events", events(1, ["other"])),
    signed("result", first),
    signRenewal(
      fixtureSessionKey.privateKey,
      channel,
      "a".repeat(64),
      "1",
      String(Math.floor(Date.now() / 1000)),
    ),
  ]) {
    const response = await call("events", { body: first, signature })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe("")
  }
  expect((await readEvents()).batches).toEqual([])
  expect((await call("events", { body: first, signature: signed("events", first) })).status).toBe(
    204,
  )
  expect((await readEvents()).batches).toEqual([{ sequence: 1, lines: ['{"type":"started"}'] }])
})

test("event batches are numbered with no gap, and the last one sent again changes nothing", async () => {
  const again = events(1, ['{"type":"started"}'])
  expect((await call("events", { body: again, signature: signed("events", again) })).status).toBe(
    204,
  )
  const changed = events(1, ["changed"])
  expect(
    (await call("events", { body: changed, signature: signed("events", changed) })).status,
  ).toBe(403)
  const gap = events(3, ["gap"])
  expect((await call("events", { body: gap, signature: signed("events", gap) })).status).toBe(403)
  const second = events(2, ["second"])
  expect((await call("events", { body: second, signature: signed("events", second) })).status).toBe(
    204,
  )
  const extra = JSON.stringify({ sequence: 3, lines: [], branch: "x" })
  expect((await call("events", { body: extra, signature: signed("events", extra) })).status).toBe(
    403,
  )
  expect((await readEvents()).batches.map((batch) => batch.sequence)).toEqual([1, 2])
  expect((await readEvents(1)).batches).toEqual([{ sequence: 2, lines: ["second"] }])
})

test("a fault of the gateway's store on a run route answers 503 and holds nothing", async () => {
  await inStore(
    sql`CREATE TRIGGER fixture_events_fault BEFORE INSERT ON capability_run_events
      BEGIN SELECT RAISE(FAIL,'fixture store fault'); END`,
  )
  try {
    const last = (await readEvents()).batches.at(-1)?.sequence ?? 0
    const body = events(last + 1, ['{"type":"fault"}'])
    const response = await call("events", { body, signature: signed("events", body) })
    expect(response.status).toBe(503)
    expect((await readEvents(last)).batches).toEqual([])
  } finally {
    await inStore(sql`DROP TRIGGER fixture_events_fault`)
  }
})

test("a batch whose declared size passes the bound is refused before its body is read", async () => {
  let pulled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true
      },
    },
    { highWaterMark: 0 },
  )
  const response = await Effect.runPromise(
    gateway.handle(
      new Request(`${origin}/capabilities/v1/run/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          [runSignatureHeader]: "A".repeat(86),
          "content-length": String(maxEventBatchBytes + 1),
        },
        body,
        duplex: "half",
      }),
    ),
  )
  expect(response.status).toBe(403)
  expect(pulled).toBe(false)
  const short = events(3, ["short"])
  expect(
    (await call("events", { body: short, signature: signed("events", short), length: "1000" }))
      .status,
  ).toBe(403)
})

test("the one result is held once, as its exact bytes, and read back in parts", async () => {
  const bundle = Buffer.alloc(700 * 1024, 7)
  const body = framed('{"sourceSha":"d"}', bundle)
  expect((await call("result", { body, signature: null })).status).toBe(403)
  expect((await call("result", { body, signature: signed("events", body) })).status).toBe(403)
  const empty = framed('{"sourceSha":"d"}', new Uint8Array())
  expect((await call("result", { body: empty, signature: signed("result", empty) })).status).toBe(
    403,
  )
  const large = framed("x".repeat(maxResultManifestBytes + 1), bundle)
  expect((await call("result", { body: large, signature: signed("result", large) })).status).toBe(
    403,
  )
  expect((await readEvents()).result).toBe(false)
  expect((await call("result", { body, signature: signed("result", body) })).status).toBe(204)
  expect((await call("result", { body, signature: signed("result", body) })).status).toBe(204)
  const other = framed('{"sourceSha":"e"}', bundle)
  expect((await call("result", { body: other, signature: signed("result", other) })).status).toBe(
    403,
  )
  expect((await readEvents()).result).toBe(true)
  const parts: Array<Buffer> = []
  let size = 0
  let sha256 = ""
  for (let offset = 0; offset === 0 || offset < size;) {
    const part = await inStore(store.readResult("run", offset))
    size = part.size
    sha256 = part.sha256
    parts.push(Buffer.from(part.part, "base64"))
    offset += parts.at(-1)!.length
  }
  expect(parts.length).toBe(2)
  expect(Buffer.concat(parts).equals(body)).toBe(true)
  expect(sha256).toBe(createHash("sha256").update(body).digest("hex"))
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        Effect.provideService(store.readResult("run", size), SqlClient.SqlClient, sql),
      ),
    ),
  ).toBe(true)
})

test("the run routes cost the run no call", async () => {
  expect(await usedCalls()).toBe(0)
})

test("the gateway's own end of a run is read with the counts it used", async () => {
  expect((await readEvents()).ended).toBeNull()
  await inStore(
    sql`UPDATE capability_usage SET calls=3,output_tokens=900,spent=1 WHERE run_id='run'`,
  )
  expect((await readEvents()).ended).toEqual({ reason: "budget", calls: 3, outputTokens: 900 })
  await inStore(store.revokeTwoHolders("run"))
  expect((await readEvents()).ended).toEqual({ reason: "two holders", calls: 3, outputTokens: 900 })
})

test("a revoked run's token reaches no run route, and the daemon still reads its records", async () => {
  // The run was revoked by the case before.
  expect((await call("launch")).status).toBe(403)
  const late = events(3, ["late"])
  expect((await call("events", { body: late, signature: signed("events", late) })).status).toBe(403)
  expect((await readEvents()).batches.length).toBe(2)
})

test("the listener refuses a run route reached by a path that a URL parser changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "run-routes-listener-"))
  const socket = join(directory, "front", "gateway.sock")
  const seen: Array<string> = []
  const close = await serveCapabilityListener(
    {
      socket,
      front: { uid: process.getuid!(), gid: process.getgid!() },
      service: "gateway.fixture",
    },
    1,
    async (request) => {
      seen.push(new URL(request.url).pathname)
      return new Response(null, { status: 204 })
    },
  )
  const send = (path: string) =>
    new Promise<string>((resolve) => {
      const connection = connect(socket)
      let answer = ""
      connection.on("data", (chunk) => (answer += chunk.toString()))
      connection.on("close", () => resolve(answer.split("\r\n")[0] ?? ""))
      connection.on("error", () => resolve(answer))
      connection.write(
        `GET ${path} HTTP/1.1\r\nhost: gateway.fixture\r\nx-forwarded-for: 100.64.0.1\r\n` +
          "x-forwarded-proto: https\r\nx-forwarded-host: gateway.fixture\r\nconnection: close\r\n\r\n",
      )
    })
  try {
    expect(await send("/capabilities/v1/x/../run/launch")).toContain("403")
    expect(await send("/capabilities/v1/run/./launch")).toContain("403")
    expect(await send("/capabilities/v1/run/%2e%2e/run/launch")).toContain("403")
    expect(seen).toEqual([])
    expect(await send("/capabilities/v1/run/launch")).toContain("204")
    expect(seen).toEqual(["/capabilities/v1/run/launch"])
  } finally {
    await close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("workflowd's grant of a launch whose prompt passes the bound is refused at the control socket", () => {
  const launch = (prompt: string) =>
    Schema.decodeUnknownExit(RunLaunch)({ prompt, image, identity })
  expect(Exit.isSuccess(launch("é".repeat(maxLaunchPromptBytes / 2)))).toBe(true)
  const refused = launch("é".repeat(maxLaunchPromptBytes / 2) + "x")
  expect(Exit.isFailure(refused)).toBe(true)
  expect(String(refused)).toContain(`Expected at most ${maxLaunchPromptBytes} bytes`)
})
