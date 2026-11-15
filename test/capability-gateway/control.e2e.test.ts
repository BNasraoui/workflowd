import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { chmod, mkdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { Schema } from "effect"
import { loadCapabilityGatewayConfig } from "../../src/config"
import { CapabilityControlConfig } from "../../src/sandbox/config"
import {
  client,
  fixture,
  processGateway,
  proof,
  seedLease,
  sse,
  type Fixture,
} from "./gateway-process"

/**
 * The gateway and the daemon as two processes with two database files. The daemon side is a real
 * process of workflowd's own modules: its store, its run lifetime and its control client. It reads
 * commands on standard input and answers each with one JSON line.
 */
const src = (path: string) => JSON.stringify(resolve("src", path))
const daemonProgram = (database: string, socket: string) => `
import { createInterface } from "node:readline"
import { Effect, Exit, Layer, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStore, AgentRunStoreLive } from ${src("kernel/agent-run-store.ts")}
import { runStoreMigrations } from ${src("store/migrations.ts")}
import { makeDaemonCapability } from ${src("capability-gateway/control-client.ts")}
import { seedLease } from ${JSON.stringify(resolve("test/capability-gateway/gateway-process.ts"))}
const scope = Effect.runSync(Scope.make())
const context = await Effect.runPromise(
  Layer.buildWithScope(
    AgentRunStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ${JSON.stringify(database)} }))),
    scope,
  ),
)
const run = (effect) => Effect.runPromiseExit(Effect.provide(effect, context))
const started = await run(Effect.gen(function* () {
  yield* runStoreMigrations
  const sql = yield* SqlClient.SqlClient
  yield* sql\`INSERT OR IGNORE INTO directory_local_identity(singleton,host_id) VALUES(1,'fixture-controller')\`
  return yield* makeDaemonCapability({ socket: ${JSON.stringify(socket)}, reconcileEveryMs: 200 }).pipe(Scope.provide(scope))
}))
if (Exit.isFailure(started)) { process.stdout.write("refused\\n"); process.exit(3) }
const capability = started.value
process.stdout.write("ready\\n")
const commands = {
  seed: (runId, leaseId, actions, native) => seedLease(runId, leaseId, Number(actions), native !== "plain"),
  authorize: (runId) => capability.authorize(runId),
  bound: (runId, actions) => capability.sessionBound(runId, Number(actions), 1),
  settle: (runId) => Effect.gen(function* () { yield* (yield* AgentRunStore).cancel({ runId, now: new Date() }) }),
  reconcile: () => capability.reconcile(),
}
for await (const line of createInterface({ input: process.stdin })) {
  const [verb, ...args] = line.split(" ")
  const exit = await run(commands[verb](...args))
  process.stdout.write(JSON.stringify(Exit.isSuccess(exit)
    ? { ok: true, value: exit.value ?? null }
    : { ok: false, tag: exit.cause.reasons.map((r) => r.error?._tag ?? r._tag).join(",") }) + "\\n")
}
`

const DaemonAnswer = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optionalKey(Schema.Unknown),
    tag: Schema.optionalKey(Schema.String),
  }),
)

interface Daemon {
  readonly ready: boolean
  send(line: string): Promise<{ ok: boolean; value?: unknown; tag?: string }>
  stop(): Promise<void>
}

async function startDaemon(database: string, socket: string): Promise<Daemon> {
  const child = Bun.spawn([process.execPath, "-e", daemonProgram(database, socket)], {
    cwd: resolve("."),
    env: { PATH: process.env.PATH, HOME: "/nonexistent" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = child.stdout.getReader()
  let text = ""
  const line = async () => {
    while (!text.includes("\n")) {
      const part = await reader.read()
      if (part.done) throw new Error("daemon process ended")
      text += Buffer.from(part.value).toString()
    }
    const index = text.indexOf("\n")
    const value = text.slice(0, index)
    text = text.slice(index + 1)
    return value
  }
  const first = await line().catch(() => "refused")
  return {
    ready: first === "ready",
    send: async (command) => {
      void child.stdin.write(`${command}\n`)
      void child.stdin.flush()
      return Schema.decodeUnknownSync(DaemonAnswer)(await line())
    },
    stop: async () => {
      child.kill("SIGKILL")
      await child.exited
    },
  }
}

/** The gateway's section with its own store, control socket and the daemon's ids. */
const gatewayConfig = (f: Fixture, daemonUid = process.getuid!()) => ({
  ...f.config,
  storePath: join(f.root, "gateway.db"),
  controlSocket: join(f.root, "control", "gateway.sock"),
  daemon: { uid: daemonUid, gid: process.getgid!() },
})

/** The gateway process alone: here the daemon process, not this one, makes every control call. */
const startGateway = (f: Fixture, config: object = gatewayConfig(f)) =>
  processGateway({
    ...f,
    env: {
      PATH: process.env.PATH,
      HOME: f.root,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
    },
    reconcile: async () => undefined,
  })

const daemonDatabase = (f: Fixture) => join(f.root, "workflowd.db")
const socketOf = (f: Fixture) => join(f.root, "control", "gateway.sock")

/** Opens a session for the fixture lease and returns its run token. */
async function sessionToken(port: number, lease = "lease", jti = "jti-1") {
  const at = client(port)
  const { audience } = await at.audience(lease)
  const opened = await at.session(proof(audience, jti, { lease }))
  expect(opened.status).toBe(200)
  return (await at.grant(opened)).token
}

/** Polls `check` until it holds or `within` milliseconds pass; returns the time it took. */
async function within(ms: number, check: () => Promise<boolean>) {
  const start = performance.now()
  while (!(await check())) {
    if (performance.now() - start > ms) throw new Error(`not within ${ms} ms`)
    await Bun.sleep(25)
  }
  return performance.now() - start
}

/** One raw frame on the control socket: a 4-byte length, then the bytes. */
function rawFrame(socket: string, frame: Buffer) {
  return new Promise<string>((done) => {
    const connection = createConnection(socket)
    let answer = Buffer.alloc(0)
    connection.on("connect", () => connection.write(frame))
    connection.on("data", (chunk) => {
      answer = Buffer.concat([answer, Buffer.from(chunk)])
    })
    connection.on("error", () => done("error"))
    connection.on("close", () =>
      done(answer.length >= 4 ? answer.subarray(4).toString("utf8") : "closed"),
    )
  })
}
const framed = (body: string | Buffer, length?: number) => {
  const bytes = typeof body === "string" ? Buffer.from(body) : body
  const header = Buffer.alloc(4)
  header.writeUInt32BE(length ?? bytes.length)
  return Buffer.concat([header, bytes])
}

async function withProcesses(
  body: (
    f: Fixture,
    parts: { gateway: Awaited<ReturnType<typeof startGateway>>; daemon: Daemon },
  ) => Promise<void>,
) {
  const f = await fixture()
  const stops: Array<() => Promise<void>> = []
  try {
    const gateway = await startGateway(f)
    stops.push(() => gateway.stop())
    const daemon = await startDaemon(daemonDatabase(f), socketOf(f))
    stops.push(() => daemon.stop())
    expect(daemon.ready).toBe(true)
    await body(f, { gateway, daemon })
  } finally {
    for (const stop of stops.reverse()) await stop().catch(() => undefined)
    await f.close()
  }
}

test("a run that settles in the daemon's store ends its open stream in the gateway process", async () => {
  await withProcesses(async (f, { gateway, daemon }) => {
    expect(await daemon.send("authorize run")).toEqual({ ok: true, value: null })
    expect(await daemon.send("bound run 78")).toEqual({ ok: true, value: false })
    const token = await sessionToken(gateway.port)
    expect(await daemon.send("bound run 78")).toEqual({ ok: true, value: true })
    f.setStall(true)
    const stream = await client(gateway.port).call(token)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const settled = performance.now()
    expect((await daemon.send("settle run")).ok).toBe(true)
    let done = false
    void (async () => {
      while (!(await reader.read().catch(() => ({ done: true }))).done);
      done = true
    })()
    await within(2000, async () => done)
    const elapsed = performance.now() - settled
    console.log(`settled run to the end of its stream: ${Math.round(elapsed)} ms`)
    expect(elapsed).toBeLessThan(2000)
    expect((await client(gateway.port).call(token)).status).toBe(403)
  })
})

test("a lease that the daemon did not authorize gets no challenge, and the daemon refuses to authorize a settled run", async () => {
  await withProcesses(async (_f, { gateway, daemon }) => {
    expect((await daemon.send("seed run-b lease-b 79")).ok).toBe(true)
    expect((await client(gateway.port).challenge("lease-b")).status).not.toBe(200)
    expect((await daemon.send("settle run-b")).ok).toBe(true)
    expect(await daemon.send("authorize run-b")).toEqual({
      ok: false,
      tag: "CapabilityControlRefused",
    })
    expect((await client(gateway.port).challenge("lease-b")).status).not.toBe(200)
  })
})

test("a restart of the daemon reconciles a run that settled while it was down", async () => {
  await withProcesses(async (f, { gateway, daemon }) => {
    await daemon.send("authorize run")
    const token = await sessionToken(gateway.port)
    expect(await (await client(gateway.port).call(token)).text()).toBe(sse)
    await daemon.stop()
    // Without the daemon the gateway serves the runs it holds and accepts no new run.
    expect(await (await client(gateway.port).call(token)).text()).toBe(sse)
    await f.store(seedLease("run-n", "lease-n", 90))
    expect((await client(gateway.port).challenge("lease-n")).status).not.toBe(200)
    await f.store(
      Effect.gen(function* () {
        yield* (yield* AgentRunStore).cancel({ runId: "run", now: new Date() })
      }),
    )
    const again = await startDaemon(daemonDatabase(f), socketOf(f))
    try {
      expect(again.ready).toBe(true)
      await within(2000, async () => (await client(gateway.port).call(token)).status === 403)
    } finally {
      await again.stop()
    }
  })
})

test("a run that settled while the gateway was down is revoked when the gateway is back", async () => {
  await withProcesses(async (f, { gateway, daemon }) => {
    await daemon.send("authorize run")
    const token = await sessionToken(gateway.port)
    await gateway.stop()
    // The gateway is down: a native run is refused with a typed reason; another kind of run is not.
    expect(await daemon.send("seed run-x lease-x 91")).toEqual({ ok: true, value: null })
    expect(await daemon.send("authorize run-x")).toEqual({
      ok: false,
      tag: "CapabilityGatewayUnavailable",
    })
    expect(await daemon.send("seed run-p lease-p 92 plain")).toEqual({ ok: true, value: null })
    expect(await daemon.send("settle run-p")).toEqual({ ok: true, value: null })
    expect((await daemon.send("settle run")).ok).toBe(true)
    const back = await startGateway(f)
    try {
      await within(3000, async () => (await client(back.port).call(token)).status === 403)
    } finally {
      await back.stop()
    }
  })
})

test("the control socket refuses an unknown verb, a frame that is too long and a body that does not parse", async () => {
  await withProcesses(async (f) => {
    const socket = socketOf(f)
    expect(
      JSON.parse(await rawFrame(socket, framed(JSON.stringify({ verb: "events", body: {} })))),
    ).toEqual({
      ok: false,
      error: "verb",
    })
    expect(JSON.parse(await rawFrame(socket, framed("{not json")))).toEqual({
      ok: false,
      error: "body",
    })
    expect(
      JSON.parse(
        await rawFrame(socket, framed(JSON.stringify({ verb: "revoke", body: { runId: 7 } }))),
      ),
    ).toEqual({ ok: false, error: "body" })
    expect(JSON.parse(await rawFrame(socket, framed("{}", 4 * 1024 * 1024)))).toEqual({
      ok: false,
      error: "length",
    })
    const reconcile = JSON.parse(
      await rawFrame(socket, framed(JSON.stringify({ verb: "reconcile", body: { live: [] } }))),
    )
    expect(reconcile.ok).toBe(true)
    const socketMode = (await stat(socket)).mode & 0o777
    const directoryMode = (await stat(join(f.root, "control"))).mode & 0o777
    expect([socketMode, directoryMode]).toEqual([0o660, 0o710])
  })
})

test("the gateway refuses a caller whose uid is not the daemon's", async () => {
  const f = await fixture()
  const gateway = await startGateway(f, gatewayConfig(f, process.getuid!() + 1))
  try {
    expect(
      JSON.parse(
        await rawFrame(
          socketOf(f),
          framed(JSON.stringify({ verb: "reconcile", body: { live: [] } })),
        ),
      ),
    ).toEqual({ ok: false, error: "caller" })
    const daemon = await startDaemon(daemonDatabase(f), socketOf(f))
    try {
      expect(await daemon.send("authorize run")).toEqual({
        ok: false,
        tag: "CapabilityControlRefused",
      })
    } finally {
      await daemon.stop()
    }
  } finally {
    await gateway.stop()
    await f.close()
  }
})

test("neither process can name the other's database", async () => {
  const f = await fixture()
  try {
    const config = gatewayConfig(f)
    // The gateway reads only its own section: no daemon database path reaches it.
    const loaded = loadCapabilityGatewayConfig({
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
      WORKFLOWD_DATABASE_PATH: daemonDatabase(f),
    })
    expect(JSON.stringify(loaded)).not.toContain(daemonDatabase(f))
    expect(() =>
      loadCapabilityGatewayConfig({
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
          ...config,
          databasePath: daemonDatabase(f),
        }),
      }),
    ).toThrow()
    // The daemon's section names only the control socket, as workflowd's config decodes it.
    const daemonSection = Schema.decodeUnknownSync(CapabilityControlConfig, {
      onExcessProperty: "error",
    })
    expect(daemonSection({ socket: socketOf(f) })).toEqual({ socket: socketOf(f) })
    expect(() => daemonSection({ socket: socketOf(f), storePath: config.storePath })).toThrow()
    expect(config.storePath).not.toBe(daemonDatabase(f))
    // A gateway given the daemon's file, and a daemon given the gateway's, each refuse to start.
    await expect(startGateway(f, { ...config, storePath: daemonDatabase(f) })).rejects.toThrow()
    const gateway = await startGateway(f)
    try {
      expect((await startDaemon(config.storePath, socketOf(f))).ready).toBe(false)
    } finally {
      await gateway.stop()
    }
  } finally {
    await f.close()
  }
})

test("the gateway refuses to start when its control directory grants more than the daemon's group", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, "control"), { mode: 0o755 })
    await chmod(join(f.root, "control"), 0o755)
    await expect(startGateway(f)).rejects.toThrow()
  } finally {
    await f.close()
  }
})
