import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { connect } from "@nats-io/transport-node"
import { AckPolicy, jetstreamManager } from "@nats-io/jetstream"
import {
  RemoteTransport,
  RemoteTransportLive,
  type RemoteTransportPort,
} from "../../src/remote/transport"

const container = `workflowd-nats-transport-${process.pid}`
let server = ""
const port = 45_000 + (process.pid % 1_000)

const docker = async (...arguments_: ReadonlyArray<string>) => {
  const process = Bun.spawn(["docker", ...arguments_], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (status !== 0) throw new Error(`docker ${arguments_.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}

beforeAll(async () => {
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "-p",
    `127.0.0.1:${port}:4222`,
    "nats:2-alpine",
    "-js",
  )
  server = `nats://127.0.0.1:${port}`
})

afterAll(async () => {
  await docker("rm", "-f", container).catch(() => undefined)
})

const runTransport = <A, E>(effect: Effect.Effect<A, E, RemoteTransportPort | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(RemoteTransportLive({ servers: [server] })))),
  )

const command = (id: string, hostId = "host-a") => ({
  version: 1 as const,
  commandId: id,
  jobId: `job-${id}`,
  attempt: 1,
  generation: 1,
  hostId,
  kind: "probe" as const,
  issuedAt: "2026-08-14T12:00:00.000Z",
  expiresAt: "2026-08-14T12:01:00.000Z",
})

describe.serial("real NATS Effect transport", () => {
  test("Effect transport delivers to an online waiter and confirms ack with the server", async () => {
    const result = await runTransport(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        const waiting = yield* transport.takeHost("host-online", 10_000).pipe(Effect.fork)
        yield* Effect.sleep(25)
        yield* transport.publishCommand(command("online", "host-online"))
        const deliveries = yield* Fiber.join(waiting)
        const acknowledged = yield* deliveries[0]!.acknowledge
        return { deliveries, acknowledged }
      }),
    )

    expect(result.deliveries).toHaveLength(1)
    expect(result.deliveries[0]?.deliveryId).toMatch(/^WORKFLOWD_COMMANDS_V1:/)
    expect(result.acknowledged).toBe(true)
  }, 20_000)

  test("scoped continuous consumer delivers without application polling", async () => {
    const result = await runTransport(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        const received = yield* Deferred.make<string>()
        const consumer = yield* transport
          .consumeHost("host-continuous", (delivery) =>
            delivery.acknowledge.pipe(
              Effect.zipRight(Deferred.succeed(received, delivery.deliveryId)),
              Effect.asVoid,
            ),
          )
          .pipe(Effect.forkScoped)
        yield* Effect.sleep(100)
        yield* transport.publishCommand(command("continuous", "host-continuous"))
        const deliveryId = yield* Effect.raceFirst(
          Deferred.await(received),
          Fiber.join(consumer).pipe(Effect.as("consumer-ended")),
        )
        yield* Fiber.interrupt(consumer)
        return deliveryId
      }),
    )

    expect(result).toMatch(/^WORKFLOWD_COMMANDS_V1:/)
  }, 20_000)

  test("Effect transport reconnects after a real nats-server stop and start", async () => {
    const result = await runTransport(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        yield* Effect.tryPromise(() => docker("kill", "--signal", "KILL", container))
        yield* Effect.sleep(500)
        yield* Effect.tryPromise(() => docker("start", container))
        yield* Effect.sleep(3_000)
        yield* transport.publishCommand(command("reconnect", "host-reconnect"))
        const deliveries = yield* transport.takeHost("host-reconnect", 10_000)
        yield* deliveries[0]!.acknowledge
        return deliveries
      }),
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.data.byteLength).toBeGreaterThan(0)
  }, 20_000)

  test("JetStream rejects an actually published oversized command", async () => {
    const result = await runTransport(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        return yield* transport
          .publishRaw("workflowd.v1.commands.host-oversized", new Uint8Array(16_385))
          .pipe(Effect.either)
      }),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "RemoteTransportError", operation: "publish" },
    })
  }, 20_000)

  test("transport rejects an incompatible existing durable consumer", async () => {
    await runTransport(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
      }),
    )
    const admin = await connect({ servers: server })
    try {
      const manager = await jetstreamManager(admin)
      await manager.consumers.add("WORKFLOWD_COMMANDS_V1", {
        durable_name: "runner-host-incompatible",
        ack_policy: AckPolicy.None,
        filter_subject: "workflowd.v1.commands.other-host",
      })
      const result = await runTransport(
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          return yield* transport.takeHost("host-incompatible", 1_000).pipe(Effect.either)
        }),
      )
      expect(result).toMatchObject({
        _tag: "Left",
        left: { _tag: "RemoteTransportError", operation: "consume" },
      })
    } finally {
      await admin.close()
    }
  }, 20_000)

  test("transport rejects incompatible existing stream bounds", async () => {
    await runTransport(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
      }),
    )
    const admin = await connect({ servers: server })
    try {
      const manager = await jetstreamManager(admin)
      await manager.streams.update("WORKFLOWD_COMMANDS_V1", { max_msg_size: 32_768 })
      const result = await runTransport(
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          return yield* transport.ensureInfrastructure().pipe(Effect.either)
        }),
      )
      expect(result).toMatchObject({
        _tag: "Left",
        left: { _tag: "RemoteTransportError", operation: "ensure" },
      })
    } finally {
      await admin.close()
    }
  }, 20_000)
})
