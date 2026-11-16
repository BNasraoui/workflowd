import { expect, test } from "bun:test"
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { Schema } from "effect"
import { loadCapabilityGatewayConfig } from "../../src/config"
import { CapabilityControlConfig } from "../../src/sandbox/config"
import {
  client,
  fixture,
  proof,
  seedLease,
  sse,
  type Fixture,
  type Origin,
} from "./gateway-process"
import { framed, gatewayConfig, rawFrame, socketOf, startGateway } from "./control-socket"

/**
 * The gateway and the daemon as two processes with two database files. The daemon side is a real
 * process of workflowd's own modules: its store, its run lifetime and its control client. It reads
 * commands on standard input and answers each with one JSON line.
 */
const src = (path: string) => JSON.stringify(resolve("src", path))
const daemonProgram = (database: string, socket: string, reconcileEveryMs: number) => `
import { createInterface } from "node:readline"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStore, AgentRunStoreLive } from ${src("kernel/agent-run-store.ts")}
import { workflowdDatabase } from ${src("store/database.ts")}
import { runStoreMigrations } from ${src("store/migrations.ts")}
import { runLifetime } from ${src("store/run-lifetime.ts")}
import { makeDaemonCapability } from ${src("sandbox/capability-control.ts")}
import { seedLease } from ${JSON.stringify(resolve("test/capability-gateway/gateway-process.ts"))}
const scope = Effect.runSync(Scope.make())
const refuse = (cause) => {
  const reason = String(Cause.squash(cause)?.message ?? "").replaceAll("\\n", " ")
  process.stdout.write("refused " + reason + "\\n")
  process.exit(3)
}
const built = await Effect.runPromiseExit(
  Layer.buildWithScope(
    AgentRunStoreLive.pipe(Layer.provideMerge(workflowdDatabase(${JSON.stringify(database)}))),
    scope,
  ),
)
if (Exit.isFailure(built)) refuse(built.cause)
const context = built.value
const run = (effect) => Effect.runPromiseExit(Effect.provide(effect, context))
const started = await run(Effect.gen(function* () {
  yield* runStoreMigrations
  const sql = yield* SqlClient.SqlClient
  yield* sql\`INSERT OR IGNORE INTO directory_local_identity(singleton,host_id) VALUES(1,'fixture-controller')\`
  return yield* makeDaemonCapability({ socket: ${JSON.stringify(socket)}, reconcileEveryMs: ${reconcileEveryMs} }).pipe(Scope.provide(scope))
}))
if (Exit.isFailure(started)) refuse(started.cause)
const capability = started.value
process.stdout.write("ready\\n")
const commands = {
  seed: (runId, leaseId, actions, native) => seedLease(runId, leaseId, Number(actions), native !== "plain"),
  authorize: (runId) => capability.authorize(runId),
  bound: (runId, actions) => capability.sessionBound(runId, Number(actions), 1),
  settle: (runId) => Effect.gen(function* () { yield* (yield* AgentRunStore).cancel({ runId, now: new Date() }) }),
  // A change that notifies, then waits 300 ms inside its transaction before it writes the state.
  "settle-late": (runId) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* runLifetime(sql).change(runId, Effect.sleep("300 millis").pipe(
      Effect.andThen(sql\`UPDATE kernel_agent_runs SET state='cancelled' WHERE run_id=\${runId}\`),
    ))
  }),
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
  /** Why the daemon refused to start, when it did. */
  readonly refusal: string
  send(line: string): Promise<{ ok: boolean; value?: unknown; tag?: string }>
  stop(): Promise<void>
}

/** The daemon process; it reconciles at start and every `reconcileEveryMs`. */
async function startDaemon(
  database: string,
  socket: string,
  reconcileEveryMs = 200,
): Promise<Daemon> {
  const child = Bun.spawn(
    [process.execPath, "-e", daemonProgram(database, socket, reconcileEveryMs)],
    {
      cwd: resolve("."),
      // A writable home of its own, beside its database, as Bun needs one for its caches.
      env: { PATH: process.env.PATH, HOME: dirname(database) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  )
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
    refusal: first.startsWith("refused") ? first.slice("refused".length).trim() : "",
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

const daemonDatabase = (f: Fixture) => join(f.root, "workflowd.db")

/** Opens a session for the fixture lease and returns its run token. */
async function sessionToken(gateway: Origin, lease = "lease", jti = "jti-1") {
  const at = client(gateway)
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

async function withProcesses(
  body: (
    f: Fixture,
    parts: { gateway: Awaited<ReturnType<typeof startGateway>>; daemon: Daemon },
  ) => Promise<void>,
  periods: { readonly reconcileEveryMs?: number; readonly staleSweepMs?: number } = {},
) {
  const f = await fixture()
  const stops: Array<() => Promise<void>> = []
  try {
    const gateway = await startGateway(f, {
      ...gatewayConfig(f),
      ...(periods.staleSweepMs === undefined ? {} : { staleSweepMs: periods.staleSweepMs }),
    })
    stops.push(() => gateway.stop())
    const daemon = await startDaemon(daemonDatabase(f), socketOf(f), periods.reconcileEveryMs)
    stops.push(() => daemon.stop())
    expect(daemon.ready).toBe(true)
    await body(f, { gateway, daemon })
  } finally {
    for (const stop of stops.reverse()) await stop().catch(() => undefined)
    await f.close()
  }
}

/**
 * Only the daemon's revoke at the change of the run, and the gateway's abort on that revoke, can
 * end the stream inside the bound: the daemon reconciles once an hour and the gateway sweeps
 * stale streams once a minute, each after its start.
 */
const streamEndBoundMs = 500
test("a run that settles in the daemon's store ends its open stream in the gateway process", async () => {
  await withProcesses(
    async (f, { gateway, daemon }) => {
      expect(await daemon.send("authorize run")).toEqual({ ok: true, value: null })
      expect(await daemon.send("bound run 78")).toEqual({ ok: true, value: false })
      const token = await sessionToken(gateway)
      expect(await daemon.send("bound run 78")).toEqual({ ok: true, value: true })
      f.setStall(true)
      const stream = await client(gateway).call(token)
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
      await within(streamEndBoundMs, async () => done)
      const elapsed = performance.now() - settled
      console.log(`settled run to the end of its stream: ${Math.round(elapsed)} ms`)
      expect(elapsed).toBeLessThan(streamEndBoundMs)
      expect((await client(gateway).call(token)).status).toBe(403)
    },
    { reconcileEveryMs: 3600000, staleSweepMs: 60000 },
  )
})

test("the daemon reads a changed run only once the change commits, so the revoke is not lost", async () => {
  await withProcesses(
    async (f, { gateway, daemon }) => {
      expect(await daemon.send("authorize run")).toEqual({ ok: true, value: null })
      const token = await sessionToken(gateway)
      expect(await daemon.send("bound run 78")).toEqual({ ok: true, value: true })
      f.setStall(true)
      const stream = await client(gateway).call(token)
      const reader = stream.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      // The change notifies the daemon's control client 300 ms before it writes. A read that did
      // not wait for the commit would find the run live and grant it again, and nothing but the
      // hourly reconcile would revoke it.
      expect((await daemon.send("settle-late run")).ok).toBe(true)
      const committed = performance.now()
      let done = false
      void (async () => {
        while (!(await reader.read().catch(() => ({ done: true }))).done);
        done = true
      })()
      await within(streamEndBoundMs, async () => done)
      console.log(
        `commit to the end of the stream: ${Math.round(performance.now() - committed)} ms`,
      )
      expect((await client(gateway).call(token)).status).toBe(403)
    },
    { reconcileEveryMs: 3600000 },
  )
})

test("a lease that the daemon did not authorize gets no challenge, and the daemon refuses to authorize a settled run", async () => {
  await withProcesses(async (_f, { gateway, daemon }) => {
    expect((await daemon.send("seed run-b lease-b 79")).ok).toBe(true)
    expect((await client(gateway).challenge("lease-b")).status).not.toBe(200)
    expect((await daemon.send("settle run-b")).ok).toBe(true)
    expect(await daemon.send("authorize run-b")).toEqual({
      ok: false,
      tag: "CapabilityControlRefused",
    })
    expect((await client(gateway).challenge("lease-b")).status).not.toBe(200)
  })
})

test("a restart of the daemon reconciles a run that settled while it was down", async () => {
  await withProcesses(async (f, { gateway, daemon }) => {
    await daemon.send("authorize run")
    const token = await sessionToken(gateway)
    expect(await (await client(gateway).call(token)).text()).toBe(sse)
    await daemon.stop()
    // Without the daemon the gateway serves the runs it holds and accepts no new run.
    expect(await (await client(gateway).call(token)).text()).toBe(sse)
    await f.store(seedLease("run-n", "lease-n", 90))
    expect((await client(gateway).challenge("lease-n")).status).not.toBe(200)
    await f.store(
      Effect.gen(function* () {
        yield* (yield* AgentRunStore).cancel({ runId: "run", now: new Date() })
      }),
    )
    const again = await startDaemon(daemonDatabase(f), socketOf(f))
    try {
      expect(again.ready).toBe(true)
      await within(2000, async () => (await client(gateway).call(token)).status === 403)
    } finally {
      await again.stop()
    }
  })
})

test("a run that settled while the gateway was down is revoked when the gateway is back", async () => {
  await withProcesses(async (f, { gateway, daemon }) => {
    await daemon.send("authorize run")
    const token = await sessionToken(gateway)
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
      await within(3000, async () => (await client(back).call(token)).status === 403)
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
    // A frame with bytes after its end.
    expect(
      JSON.parse(await rawFrame(socket, Buffer.concat([framed("{}"), Buffer.from("{}")]))),
    ).toEqual({ ok: false, error: "length" })
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
      expect(daemon.ready).toBe(true)
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
    // A gateway given the daemon's file, and a daemon given the gateway's, each refuse to start
    // before they write to it: the file's bytes, and the names of SQLite's files beside it, stay.
    const snapshot = async (path: string) => ({
      bytes: new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex"),
      names: (await readdir(dirname(path))).filter((name) => name.startsWith(basename(path))),
    })
    const daemonFile = await snapshot(daemonDatabase(f))
    await expect(startGateway(f, { ...config, storePath: daemonDatabase(f) })).rejects.toThrow(
      "the gateway's store holds tables of another store",
    )
    expect(await snapshot(daemonDatabase(f))).toEqual(daemonFile)
    const gateway = await startGateway(f)
    try {
      const gatewayFile = await snapshot(config.storePath)
      const daemon = await startDaemon(config.storePath, socketOf(f))
      expect(daemon.ready).toBe(false)
      expect(daemon.refusal).toContain("is the capability gateway's store")
      expect(await snapshot(config.storePath)).toEqual(gatewayFile)
    } finally {
      await gateway.stop()
    }
    // With the gateway stopped, no process has its file open.
    const stoppedFile = await snapshot(config.storePath)
    const daemon = await startDaemon(config.storePath, socketOf(f))
    expect(daemon.refusal).toContain("is the capability gateway's store")
    expect(await snapshot(config.storePath)).toEqual(stoppedFile)
  } finally {
    await f.close()
  }
})
