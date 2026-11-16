import { expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { createServer, type Socket } from "node:net"
import { Effect, Exit, Logger, Schema } from "effect"
import { ControlRequest, controlFrame } from "../../src/capability-control/protocol"
import { makeDaemonCapability } from "../../src/sandbox/capability-control"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore } from "../../src/sandbox/store"
import {
  client,
  fixture,
  gatewaySource,
  proof,
  seedLease,
  startGatewayProcess,
  type Fixture,
  type Gateway,
  type Origin,
} from "../capability-gateway/gateway-process"
import { sandboxGithubFixture } from "./harness"

/**
 * workflowd's lease service for actions-native leases, against the gateway as its own process on
 * its control socket. The lease's GitHub side is the sandbox GitHub fixture of one lease.
 */
const policy = {
  repository: "fixture/repo",
  repositoryId: 12,
  installationId: 1,
  workflowSha: "a".repeat(40),
  appActorId: 56,
  agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
}

/** The gateway process alone: no control call is made for the test, the lease service makes each. */
const startGateway = (f: Fixture) =>
  startGatewayProcess([process.execPath, "-e", gatewaySource(f)], f.env, f.front)

/** Polls `check` until it holds or `ms` milliseconds pass; returns the time it took. */
async function within(ms: number, check: () => Promise<boolean>) {
  const start = performance.now()
  while (!(await check())) {
    if (performance.now() - start > ms) throw new Error(`not within ${ms} ms`)
    await Bun.sleep(50)
  }
  return performance.now() - start
}

/** The lease service of one GitHub fixture lease, with workflowd's control client of the gateway. */
const leaseService = (
  f: Fixture,
  github: Awaited<ReturnType<typeof sandboxGithubFixture>>,
  gateway: Effect.Success<ReturnType<typeof makeDaemonCapability>>,
) =>
  Effect.gen(function* () {
    const api = yield* makeSandboxGithub(github.github, github.OctokitClass)
    return yield* makeSandboxLeaseService(
      api,
      f.root,
      () => Promise.reject(new Error("no controller command for a private lease")),
      { native: { gateway } },
    )
  })

/** The runner of the fixture's Actions run 41 opens a session for `lease`; its run token. */
async function runnerSession(gateway: Origin, lease: string, actionsRunId = "41") {
  const at = client(gateway)
  const { audience } = await at.audience(lease)
  const opened = await at.session(
    proof(audience, `jti-${lease}-${actionsRunId}`, { lease, claims: { run_id: actionsRunId } }),
  )
  if (opened.status !== 200) return { status: opened.status, token: "" }
  return { status: 200, token: (await at.grant(opened)).token }
}

const failureTags = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) =>
        reason._tag === "Fail" ? String(Reflect.get(Object(reason.error), "_tag")) : reason._tag,
      )
    : []

test("with the gateway down, a native acquisition fails with a typed reason, and a plain one does not", async () => {
  const f = await fixture()
  const native = await sandboxGithubFixture(policy, "lease-n")
  const plain = await sandboxGithubFixture(policy, "lease-p")
  plain.mutateRun({ id: 42 })
  try {
    await f.store(
      Effect.gen(function* () {
        yield* seedLease("run-n", "lease-n", null)
        yield* seedLease("run-p", "lease-p", null, false)
        // No gateway serves the control socket.
        const gateway = yield* makeDaemonCapability({
          socket: f.config.controlSocket,
          reconcileEveryMs: 3600000,
        })
        const nativeLeases = yield* leaseService(f, native, gateway)
        const plainLeases = yield* leaseService(f, plain, gateway)
        const refused = yield* Effect.exit(nativeLeases.acquire("run-n"))
        expect(failureTags(refused)).toEqual(["CapabilityGatewayUnavailable"])
        expect((yield* (yield* makeSandboxStore).read("run-n"))?.state).toBe("starting")
        const acquired = yield* plainLeases.acquire("run-p")
        expect([acquired.state, acquired.actions_run_id]).toEqual(["starting", 42])
      }),
    )
  } finally {
    await native.close()
    await plain.close()
    await f.close()
  }
})

test("an actions-native lease becomes ready on its runner's gateway session, and not before", async () => {
  const f = await fixture()
  const github = await sandboxGithubFixture(policy, "lease-a")
  const gateway = await startGateway(f)
  try {
    await f.store(
      Effect.gen(function* () {
        yield* seedLease("run-a", "lease-a", null)
        const capability = yield* makeDaemonCapability({
          socket: f.config.controlSocket,
          reconcileEveryMs: 3600000,
        })
        const leases = yield* leaseService(f, github, capability)
        // Before the first acquisition the gateway holds no grant: no challenge.
        const challenge = () => Effect.promise(() => client(gateway).challenge("lease-a"))
        expect((yield* challenge()).status).not.toBe(200)
        // The acquisition records Actions run 41 and grants it; without a session it stays starting.
        expect((yield* leases.acquire("run-a")).state).toBe("starting")
        expect((yield* challenge()).status).toBe(200)
        // A runner of another Actions run opens no session, and the lease stays starting.
        const other = yield* Effect.promise(() => runnerSession(gateway, "lease-a", "79"))
        expect(other.status).not.toBe(200)
        expect((yield* leases.acquire("run-a")).state).toBe("starting")
        // The runner of run 41 opens its session: the next acquisition makes the lease ready.
        const opened = yield* Effect.promise(() => runnerSession(gateway, "lease-a"))
        expect(opened.status).toBe(200)
        const ready = yield* leases.acquire("run-a")
        expect([ready.state, ready.peer_id, ready.transport]).toEqual(["ready", null, null])
      }),
    )
  } finally {
    await gateway.stop()
    await github.close()
    await f.close()
  }
})

test("a revoked run's session does not make its lease ready: its acquisition is refused", async () => {
  const f = await fixture()
  const github = await sandboxGithubFixture(policy, "lease-r")
  const gateway = await startGateway(f)
  try {
    await f.store(
      Effect.gen(function* () {
        yield* seedLease("run-r", "lease-r", null)
        const capability = yield* makeDaemonCapability({
          socket: f.config.controlSocket,
          reconcileEveryMs: 3600000,
        })
        const leases = yield* leaseService(f, github, capability)
        expect((yield* leases.acquire("run-r")).state).toBe("starting")
        const opened = yield* Effect.promise(() => runnerSession(gateway, "lease-r"))
        expect(opened.status).toBe(200)
        yield* capability.revoke("run-r")
        // The gateway refuses to grant the revoked run again, so the acquisition fails.
        expect(failureTags(yield* Effect.exit(leases.acquire("run-r")))).toEqual([
          "CapabilityControlRefused",
        ])
        expect((yield* (yield* makeSandboxStore).read("run-r"))?.state).toBe("starting")
      }),
    )
  } finally {
    await gateway.stop()
    await github.close()
    await f.close()
  }
})

/**
 * A gateway that someone took over, on the control socket: it answers every request `refused`.
 * It takes the control directory and the socket path that the killed gateway left.
 */
async function refusingGateway(socket: string) {
  const server = createServer((connection) => {
    connection.on("data", () => connection.end(controlFrame({ ok: false, error: "refused" })))
    connection.on("error", () => connection.destroy())
  })
  // The killed gateway left its socket.
  await rm(socket, { force: true })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return () => new Promise<void>((resolve) => server.close(() => resolve()))
}

test("a native lease is released when the gateway is down or refuses the revoke, and the next reconcile revokes its run", async () => {
  const f = await fixture()
  const down = await sandboxGithubFixture(policy, "lease-d")
  const refusing = await sandboxGithubFixture(policy, "lease-x")
  refusing.mutateRun({ id: 42 })
  let gateway: Gateway | undefined = await startGateway(f)
  const logs: string[] = []
  try {
    await f.store(
      Effect.gen(function* () {
        yield* seedLease("run-d", "lease-d", null)
        yield* seedLease("run-x", "lease-x", null)
        // workflowd's own period of reconcile.
        const capability = yield* makeDaemonCapability({ socket: f.config.controlSocket })
        const downLeases = yield* leaseService(f, down, capability)
        const refusingLeases = yield* leaseService(f, refusing, capability)
        const tokens: string[] = []
        for (const [leases, runId, lease, actionsRunId] of [
          [downLeases, "run-d", "lease-d", "41"],
          [refusingLeases, "run-x", "lease-x", "42"],
        ] as const) {
          yield* leases.acquire(runId)
          const opened = yield* Effect.promise(() => runnerSession(gateway!, lease, actionsRunId))
          expect((yield* leases.acquire(runId)).state).toBe("ready")
          tokens.push(opened.token)
        }
        const works = (token: string) =>
          Effect.promise(async () => (await client(gateway!).call(token)).status === 200)
        for (const token of tokens) expect(yield* works(token)).toBe(true)
        const read = (runId: string) =>
          Effect.flatMap(makeSandboxStore, (store) => store.read(runId))
        // The gateway is down: the release goes on and the failed revoke is recorded.
        yield* Effect.promise(() => gateway!.stop())
        gateway = undefined
        down.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* Effect.exit(downLeases.release("run-d"))
        expect(["releasing", "released"]).toContain(String((yield* read("run-d"))?.state))
        // A gateway that refuses the revoke: the release goes on as well.
        const stopRefusing = yield* Effect.promise(() => refusingGateway(f.config.controlSocket))
        refusing.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* Effect.exit(refusingLeases.release("run-x"))
        expect(["releasing", "released"]).toContain(String((yield* read("run-x"))?.state))
        // Each release started its revoke; each revoke fails and is logged.
        yield* Effect.promise(() =>
          within(15000, async () =>
            Promise.resolve(
              logs.filter((line) => line.includes("revoke unconfirmed")).length === 2,
            ),
          ),
        )
        yield* Effect.promise(stopRefusing)
        // The gateway is back, with the grants it held. workflowd's next reconcile, within its
        // period of 10 seconds, revokes both runs.
        gateway = yield* Effect.promise(() => startGateway(f))
        const back = gateway
        const elapsed = yield* Effect.promise(() =>
          within(12000, async () => {
            const statuses = await Promise.all(
              tokens.map(async (token) => (await client(back).call(token)).status),
            )
            return statuses.every((status) => status === 403)
          }),
        )
        console.log(`gateway start to the revoke of the released runs: ${Math.round(elapsed)} ms`)
      }).pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])),
      ),
    )
  } finally {
    await gateway?.stop()
    await down.close()
    await refusing.close()
    await f.close()
  }
}, 40000)

/**
 * A gateway that someone took over, on the control socket: it answers a reconcile at once and
 * holds each revoke unanswered until `answer`. `held` resolves once it holds a whole revoke;
 * `closed` resolves when the caller closes a revoke's connection.
 */
async function silentGateway(socket: string) {
  const held = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const revokes: Socket[] = []
  const server = createServer((connection) => {
    let request = Buffer.alloc(0)
    connection.on("data", (chunk) => {
      request = Buffer.concat([request, Buffer.from(chunk)])
      if (request.length < 4 || request.readUInt32BE(0) !== request.length - 4) return
      const { verb } = Schema.decodeUnknownSync(ControlRequest)(
        request.subarray(4).toString("utf8"),
      )
      if (verb !== "revoke") return connection.end(controlFrame({ ok: true, value: null }))
      revokes.push(connection)
      connection.on("close", () => closed.resolve())
      held.resolve()
    })
    connection.on("error", () => connection.destroy())
  })
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    held: held.promise,
    closed: closed.promise,
    answer: () => {
      for (const connection of revokes) connection.end(controlFrame({ ok: true, value: null }))
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test("the release of a native lease, and the release of a plain lease after it, end while the gateway holds the revoke unanswered", async () => {
  const f = await fixture()
  const native = await sandboxGithubFixture(policy, "lease-h")
  const plain = await sandboxGithubFixture(policy, "lease-q")
  plain.mutateRun({ id: 42 })
  const silent = await silentGateway(f.config.controlSocket)
  const logs: string[] = []
  try {
    await f.store(
      Effect.gen(function* () {
        yield* seedLease("run-h", "lease-h", null)
        yield* seedLease("run-q", "lease-q", null, false)
        const capability = yield* makeDaemonCapability({
          socket: f.config.controlSocket,
          reconcileEveryMs: 3600000,
        })
        const nativeLeases = yield* leaseService(f, native, capability)
        const plainLeases = yield* leaseService(f, plain, capability)
        yield* plainLeases.acquire("run-q")
        native.mutateRun({ status: "completed", conclusion: "cancelled" })
        plain.mutateRun({ status: "completed", conclusion: "cancelled" })
        const read = (runId: string) =>
          Effect.flatMap(makeSandboxStore, (store) => store.read(runId))
        // The two releases one after the other, as one pass of the dispatch loop makes them.
        yield* Effect.exit(nativeLeases.release("run-h"))
        yield* Effect.exit(plainLeases.release("run-q"))
        expect(["releasing", "released"]).toContain(String((yield* read("run-h"))?.state))
        expect(["releasing", "released"]).toContain(String((yield* read("run-q"))?.state))
        // The gateway holds the revoke of the native run, and no failure of it is recorded.
        yield* Effect.promise(() => silent.held)
        const heldAt = performance.now()
        expect(logs.filter((line) => line.includes("revoke unconfirmed"))).toEqual([])
        // The revoke ends when the gateway answers it, after both releases.
        silent.answer()
        const answeredAt = performance.now()
        yield* Effect.promise(() => silent.closed)
        // The client ends a connection that is idle for 10 seconds (`controlClient`).
        expect(
          answeredAt - heldAt,
          "the gateway answered within the idle limit of the client's connection",
        ).toBeLessThan(10000)
        expect(logs.filter((line) => line.includes("revoke unconfirmed"))).toEqual([])
      }).pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])),
      ),
    )
  } finally {
    await silent.stop()
    await native.close()
    await plain.close()
    await f.close()
  }
}, 40000)

test("a revoke that a stop of the daemon interrupts is logged with its run and the cause interrupted", async () => {
  const f = await fixture()
  const native = await sandboxGithubFixture(policy, "lease-i")
  const silent = await silentGateway(f.config.controlSocket)
  const logs: string[] = []
  try {
    await f.store(
      Effect.gen(function* () {
        yield* seedLease("run-i", "lease-i", null)
        native.mutateRun({ status: "completed", conclusion: "cancelled" })
        // The daemon's client lives in its own scope; its end is the daemon's stop.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const capability = yield* makeDaemonCapability({
              socket: f.config.controlSocket,
              reconcileEveryMs: 3600000,
            })
            const leases = yield* leaseService(f, native, capability)
            yield* Effect.exit(leases.release("run-i"))
            yield* Effect.promise(() => silent.held)
          }),
        )
        expect(logs.filter((line) => line.includes("revoke unconfirmed"))).toEqual([
          "Capability gateway revoke unconfirmed for run-i; the next reconcile revokes it: interrupted",
        ])
      }).pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])),
      ),
    )
  } finally {
    await silent.stop()
    await native.close()
    await f.close()
  }
})

/**
 * A stand-in gateway on the control socket that records each whole request, with the runs that
 * a reconcile names live and the time of `now` at its arrival. It holds unanswered each revoke
 * and each reconcile that `holds` names by its number among the reconciles, from 1; it answers
 * each other request at once.
 */
async function recordingGateway(
  socket: string,
  holds: (reconcile: number) => boolean,
  now: () => number,
) {
  const requests: Array<{
    readonly verb: string
    readonly live: ReadonlyArray<string>
    readonly at: number
  }> = []
  const Live = Schema.Struct({ live: Schema.Array(Schema.Struct({ runId: Schema.String })) })
  const server = createServer((connection) => {
    let request = Buffer.alloc(0)
    connection.on("data", (chunk) => {
      request = Buffer.concat([request, Buffer.from(chunk)])
      if (request.length < 4 || request.readUInt32BE(0) !== request.length - 4) return
      const { verb, body } = Schema.decodeUnknownSync(ControlRequest)(
        request.subarray(4).toString("utf8"),
      )
      const live =
        verb === "reconcile"
          ? Schema.decodeUnknownSync(Live)(body).live.map(({ runId }) => runId)
          : []
      requests.push({ verb, live, at: now() })
      const reconciles = requests.filter((recorded) => recorded.verb === "reconcile").length
      if (verb === "revoke" || (verb === "reconcile" && holds(reconciles))) return
      connection.end(controlFrame({ ok: true, value: null }))
    })
    connection.on("error", () => connection.destroy())
  })
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    reconciles: () => requests.filter(({ verb }) => verb === "reconcile"),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test("a released run whose revoke fails is revoked by the next reconcile, which reaches the gateway within 40 seconds of the release on the test clock", async () => {
  const { TestClock } = await import("effect/testing")
  const f = await fixture()
  const native = await sandboxGithubFixture(policy, "lease-b")
  let now = () => 0
  // The second reconcile is in flight at the release; the gateway holds it unanswered.
  const gateway = await recordingGateway(
    f.config.controlSocket,
    (reconcile) => reconcile === 2,
    () => now(),
  )
  const logs: string[] = []
  const failed =
    "Capability gateway revoke unconfirmed for run-b; the next reconcile revokes it: timed out"
  /**
   * Moves the test clock a second at a time, and lets the socket calls that it starts run
   * between the steps, until `done` holds; it fails with `what` past `limitMs` of the clock.
   */
  const advanceUntil = (done: () => boolean, limitMs: number, what: string) =>
    Effect.gen(function* () {
      for (let moved = 0; !done(); moved += 1000) {
        if (moved >= limitMs)
          return yield* Effect.die(new Error(`${what} did not come within ${limitMs} ms`))
        yield* TestClock.adjust("1 second")
        yield* Effect.promise(() => Bun.sleep(5))
      }
    })
  try {
    await f.store(
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed)
        now = () => clock.currentTimeMillisUnsafe()
        yield* seedLease("run-b", "lease-b", 41)
        native.mutateRun({ status: "completed", conclusion: "cancelled" })
        const capability = yield* makeDaemonCapability({ socket: f.config.controlSocket })
        const leases = yield* leaseService(f, native, capability)
        yield* advanceUntil(() => gateway.reconciles().length === 2, 30000, "a second reconcile")
        // The reconcile in flight read the run as live, and holds the only permit of the client.
        expect(gateway.reconciles().map(({ live }) => live.includes("run-b"))).toEqual([true, true])
        const released = now()
        yield* Effect.exit(leases.release("run-b"))
        // The revoke waits for the permit within its limit of 15 seconds, and fails; the held
        // reconcile ends at its own limit, and the next one starts after the period.
        yield* advanceUntil(
          () => logs.includes(failed) && gateway.reconciles().length === 3,
          60000,
          "the failed revoke and a third reconcile",
        )
        const third = gateway.reconciles()[2]!
        expect(third.live, "the first reconcile after the release names the run").not.toContain(
          "run-b",
        )
        expect(
          third.at - released,
          "the reconcile after a failed revoke reaches the gateway within 40 seconds",
        ).toBeLessThanOrEqual(40000)
        console.log(`release to the next reconcile, on the test clock: ${third.at - released} ms`)
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])),
      ),
    )
  } finally {
    await gateway.stop()
    await native.close()
    await f.close()
  }
})
