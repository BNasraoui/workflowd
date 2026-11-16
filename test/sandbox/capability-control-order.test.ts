import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { dirname } from "node:path"
import { Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  ControlRequest,
  controlFrame,
  maxControlConnections,
} from "../../src/capability-control/protocol"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeDaemonCapability } from "../../src/sandbox/capability-control"
import { fixture, seedLease } from "../capability-gateway/gateway-process"

/**
 * The order of workflowd's control calls: the calls of one run reach the gateway one at a time,
 * in the order they start, and the calls of different runs do not wait for each other. The
 * client runs on the test clock, which no test moves: a call that ends, ends inside its limit.
 */

/** One request as the stand-in gateway saw it: its verb and the run it names. */
type Request = { readonly verb: string; readonly runId: string }

const Body = Schema.Struct({
  runId: Schema.optional(Schema.String),
  grant: Schema.optional(Schema.Struct({ runId: Schema.String })),
  live: Schema.optional(Schema.Array(Schema.Struct({ runId: Schema.String }))),
})

/**
 * A stand-in gateway on the control socket. It records each whole request when it comes and
 * each answer when it goes, and the most connections it held at once. It holds unanswered each
 * request that `holds` names, until `answer`; it answers each other one at once: `false` to
 * `sessionBound`, `null` to the other verbs.
 */
async function standIn(socket: string, holds: (request: Request) => boolean) {
  const events: string[] = []
  const reconciled: Array<ReadonlyArray<string>> = []
  const held: Array<{ readonly request: Request; readonly connection: Socket }> = []
  let open = 0
  let peak = 0
  const reply = (request: Request, connection: Socket) => {
    events.push(`answered ${request.verb} ${request.runId}`)
    connection.end(
      controlFrame({ ok: true, value: request.verb === "sessionBound" ? false : null }),
    )
  }
  const server = createServer((connection) => {
    open += 1
    peak = Math.max(peak, open)
    connection.on("close", () => (open -= 1))
    connection.on("error", () => connection.destroy())
    let bytes = Buffer.alloc(0)
    connection.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      if (bytes.length < 4 || bytes.readUInt32BE(0) !== bytes.length - 4) return
      const { verb, body } = Schema.decodeUnknownSync(ControlRequest)(
        bytes.subarray(4).toString("utf8"),
      )
      const named = Schema.decodeUnknownSync(Body)(body)
      const request = { verb, runId: named.runId ?? named.grant?.runId ?? "" }
      events.push(`received ${verb} ${request.runId}`)
      if (named.live !== undefined) reconciled.push(named.live.map(({ runId }) => runId))
      if (holds(request)) return void held.push({ request, connection })
      reply(request, connection)
    })
  })
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    /** The events of `runId`, or of every run when it is undefined, in the order they came. */
    events: (runId?: string) =>
      events.filter((event) => runId === undefined || event.endsWith(` ${runId}`)),
    count: (event: string) => events.filter((recorded) => recorded === event).length,
    reconciled: () => reconciled,
    held: () => held.length,
    peak: () => peak,
    /** Answers each held request that `which` names. */
    answer: (which: (request: Request) => boolean) => {
      for (const entry of held.filter(({ request }) => which(request))) {
        held.splice(held.indexOf(entry), 1)
        reply(entry.request, entry.connection)
      }
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Waits in real time, while sockets work, until `done` holds; fails with `what` after `ms`. */
const until = (done: () => boolean, what: string, ms = 5000) =>
  Effect.promise(async () => {
    const start = performance.now()
    while (!done()) {
      if (performance.now() - start > ms) throw new Error(`${what} did not come within ${ms} ms`)
      await Bun.sleep(10)
    }
  })

/** Lets the sockets work for `ms` of real time: long enough for a request that is not held back. */
const settle = (ms = 200) => Effect.promise(() => Bun.sleep(ms))

/** Runs `body` with workflowd's control client on the test clock against a stand-in gateway. */
async function withClient(
  holds: (request: Request) => boolean,
  body: (
    capability: Effect.Success<ReturnType<typeof makeDaemonCapability>>,
    gateway: Awaited<ReturnType<typeof standIn>>,
  ) => Effect.Effect<void, unknown, typeof AgentRunStore.Identifier>,
  seeded: ReadonlyArray<string> = [],
) {
  const f = await fixture()
  const gateway = await standIn(f.config.controlSocket, holds)
  try {
    await f.store(
      Effect.gen(function* () {
        // Each seeded run is live, with an Actions run of its own.
        for (const [index, runId] of seeded.entries())
          yield* seedLease(runId, `lease-${runId}`, 41 + index)
        const capability = yield* makeDaemonCapability({
          socket: f.config.controlSocket,
          reconcileEveryMs: 3600000,
        })
        // The reconcile at start ends before the test's calls.
        yield* until(() => gateway.count("answered reconcile ") === 1, "the reconcile at start")
        yield* body(capability, gateway)
        // The test clock never moved: every call that ended, ended inside its limit of 15 s.
        expect((yield* TestClock.testClockWith(Effect.succeed)).currentTimeMillisUnsafe()).toBe(0)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  } finally {
    // The test's fibers end with its scope, which closes each connection still held.
    await gateway.stop()
    await f.close()
  }
}

const isHeld = (verb: string, runId: string) => (request: Request) =>
  request.verb === verb && request.runId === runId

test("while the gateway holds the revoke of one run, the authorize of another run is answered inside its limit", async () => {
  await withClient(
    isHeld("revoke", "run-a"),
    (capability, gateway) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(capability.revoke("run-a"))
        yield* until(() => gateway.held() === 1, "the held revoke of run-a")
        const authorized = yield* Effect.forkChild(Effect.exit(capability.authorize("run-b")))
        yield* until(
          () => gateway.count("answered authorize run-b") === 1,
          "the authorize of run-b",
        )
        expect(Exit.isSuccess(yield* Fiber.join(authorized))).toBe(true)
        expect(gateway.events("run-a")).toEqual(["received revoke run-a"])
      }),
    ["run-b"],
  )
}, 20000)

test("the calls of one run reach the gateway one after the other, in the order they start, while another run's call is held", async () => {
  let authorizeHeld = true
  await withClient(
    (request) =>
      isHeld("revoke", "run-a")(request) ||
      (authorizeHeld && isHeld("authorize", "run-b")(request)),
    (capability, gateway) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(capability.revoke("run-a"))
        yield* until(() => gateway.held() === 1, "the held revoke of run-a")
        const start = (call: Effect.Effect<unknown, unknown>) =>
          Effect.forkChild(Effect.exit(Effect.asVoid(call)))
        const calls = [
          yield* start(capability.authorize("run-b")),
          yield* start(capability.revoke("run-b")),
          yield* start(capability.sessionBound("run-b", 41, 1)),
        ]
        yield* until(() => gateway.held() === 2, "the held authorize of run-b")
        // The revoke and the session check of run-b wait for its authorize.
        yield* settle()
        expect(gateway.events("run-b")).toEqual(["received authorize run-b"])
        authorizeHeld = false
        gateway.answer(isHeld("authorize", "run-b"))
        yield* until(
          () => gateway.count("answered sessionBound run-b") === 1,
          "the session check of run-b",
        )
        expect(gateway.events("run-b")).toEqual([
          "received authorize run-b",
          "answered authorize run-b",
          "received revoke run-b",
          "answered revoke run-b",
          "received sessionBound run-b",
          "answered sessionBound run-b",
        ])
        for (const call of calls) expect(Exit.isSuccess(yield* Fiber.join(call))).toBe(true)
      }),
    ["run-b"],
  )
}, 20000)

test("after the calls of 50 runs end, the client holds no state of a run, and it never holds more connections than the gateway's places", async () => {
  let holding = true
  const runs = Array.from({ length: 50 }, (_, index) => `run-${index}`)
  await withClient(
    (request) => holding && request.verb === "revoke",
    (capability, gateway) =>
      Effect.gen(function* () {
        const calls = yield* Effect.forkChild(
          Effect.all(
            runs.map((runId) => capability.revoke(runId)),
            { concurrency: "unbounded" },
          ),
        )
        // The gateway holds the first calls: the others wait for a place.
        yield* until(() => gateway.held() === maxControlConnections, "the held revokes")
        yield* settle()
        expect(gateway.held()).toBe(maxControlConnections)
        expect(capability.runsWithCalls()).toBe(50)
        holding = false
        gateway.answer(() => true)
        yield* Fiber.join(calls)
        expect(runs.map((runId) => gateway.count(`answered revoke ${runId}`))).toEqual(
          runs.map(() => 1),
        )
        expect(gateway.peak()).toBeLessThanOrEqual(maxControlConnections)
        expect(capability.runsWithCalls()).toBe(0)
      }),
  )
}, 20000)

test("an interrupted call of a run gives up its turn, waiting or in flight, and the next call of the run goes on", async () => {
  // The gateway holds the first revoke of run-a, and each revoke of run-c.
  let revokesOfA = 0
  await withClient(
    (request) =>
      isHeld("revoke", "run-c")(request) ||
      (isHeld("revoke", "run-a")(request) && ++revokesOfA === 1),
    (capability, gateway) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(capability.revoke("run-c"))
        yield* until(() => gateway.held() === 1, "the held revoke of run-c")
        const inFlight = yield* Effect.forkChild(capability.revoke("run-a"))
        yield* until(() => gateway.held() === 2, "the held revoke of run-a")
        const waiting = yield* Effect.forkChild(capability.revoke("run-a"))
        const next = yield* Effect.forkChild(Effect.exit(capability.revoke("run-a")))
        yield* settle()
        expect(gateway.events("run-a")).toEqual(["received revoke run-a"])
        yield* Fiber.interrupt(waiting)
        yield* Fiber.interrupt(inFlight)
        yield* until(() => gateway.count("answered revoke run-a") === 1, "the next revoke")
        expect(Exit.isSuccess(yield* Fiber.join(next))).toBe(true)
        expect(gateway.events("run-a")).toEqual([
          "received revoke run-a",
          "received revoke run-a",
          "answered revoke run-a",
        ])
        // Run c's call is still held; run a has no call left.
        expect(capability.runsWithCalls()).toBe(1)
      }),
  )
}, 20000)

test("a reconcile does not reach the gateway while an authorize is in flight, and an authorize waits for a reconcile in flight", async () => {
  let authorizeHeld = true
  let reconcileHeld = false
  await withClient(
    (request) =>
      (authorizeHeld && isHeld("authorize", "run-b")(request)) ||
      (reconcileHeld && request.verb === "reconcile"),
    (capability, gateway) =>
      Effect.gen(function* () {
        const authorized = yield* Effect.forkChild(capability.authorize("run-b"))
        yield* until(() => gateway.held() === 1, "the held authorize of run-b")
        const reconciled = yield* Effect.forkChild(capability.reconcile())
        yield* settle()
        expect(gateway.count("received reconcile ")).toBe(1)
        authorizeHeld = false
        gateway.answer(() => true)
        yield* Fiber.join(authorized)
        yield* Fiber.join(reconciled)
        expect(gateway.reconciled()[1]).toContain("run-b")

        reconcileHeld = true
        yield* Effect.forkChild(capability.reconcile())
        yield* until(() => gateway.held() === 1, "the held reconcile")
        const again = yield* Effect.forkChild(Effect.exit(capability.authorize("run-b")))
        yield* settle()
        expect(gateway.count("received authorize run-b")).toBe(1)
        reconcileHeld = false
        gateway.answer(() => true)
        expect(Exit.isSuccess(yield* Fiber.join(again))).toBe(true)
        expect(gateway.count("received authorize run-b")).toBe(2)
      }),
    ["run-b"],
  )
}, 20000)

test("the change of one run is followed while the gateway holds the revoke that the change of another run started", async () => {
  await withClient(
    isHeld("revoke", "run-a"),
    (capability, gateway) =>
      Effect.gen(function* () {
        yield* capability.authorize("run-a")
        yield* capability.authorize("run-b")
        const runs = yield* AgentRunStore
        yield* runs.cancel({ runId: "run-a", now: new Date() })
        yield* until(() => gateway.held() === 1, "the held revoke of run-a")
        yield* runs.cancel({ runId: "run-b", now: new Date() })
        yield* until(() => gateway.count("answered revoke run-b") === 1, "the revoke of run-b")
      }),
    ["run-a", "run-b"],
  )
}, 20000)
