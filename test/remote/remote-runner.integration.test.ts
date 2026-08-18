import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Fiber, Logger, Scope } from "effect"
import {
  RemoteRunnerStore,
  RemoteRunnerStoreLive,
  type RemoteRunnerStorePort,
} from "../../src/remote/runner-store"
import { runRemoteRunnerIteration, runRemoteRunnerLoop } from "../../src/remote/runner"
import { decodeRemoteResult, encodeRemoteCommand, encodeRemoteFence } from "../../src/remote/codec"
import {
  RemoteTransport,
  RemoteTransportLive,
  type RemoteTransportPort,
} from "../../src/remote/transport"

const container = `workflowd-nats-runner-${process.pid}`
const port = 46_000 + (process.pid % 500)
const server = `nats://127.0.0.1:${port}`
const now = new Date("2026-08-14T12:00:00.000Z")
const SilentLogger = Logger.replace(
  Logger.defaultLogger,
  Logger.make(() => undefined),
)

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
    "nats:2.11.8-alpine",
    "-js",
  )
}, 60_000)

afterAll(async () => {
  await docker("rm", "-f", container).catch(() => undefined)
}, 30_000)

const database = () => `${process.cwd()}/remote-runner-${crypto.randomUUID()}.sqlite`
const removeDatabase = async (filename: string) => {
  await Promise.all(
    [filename, `${filename}-shm`, `${filename}-wal`].map((path) =>
      Bun.file(path)
        .delete()
        .catch(() => undefined),
    ),
  )
}

const run = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, RemoteRunnerStorePort | RemoteTransportPort | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(RemoteRunnerStoreLive),
        Effect.provide(SqliteClient.layer({ filename })),
        Effect.provide(RemoteTransportLive({ servers: [server] })),
      ),
    ).pipe(Effect.provide(SilentLogger)),
  )

const command = (commandId: string, generation: number) => ({
  version: 1 as const,
  commandId,
  jobId: "generation-job",
  attempt: generation,
  generation,
  hostId: "host-generation",
  kind: "probe" as const,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
})

describe.serial("remote runner against real JetStream", () => {
  test("idle runner publishes a saved result after real broker recovery", async () => {
    const filename = database()
    try {
      const published = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const store = yield* RemoteRunnerStore
          yield* transport.ensureInfrastructure()
          const savedCommand = {
            ...command("saved-idle-result", 1),
            jobId: "saved-idle-job",
            hostId: "host-idle-recovery",
          }
          const fence = {
            version: 1 as const,
            kind: "fence" as const,
            jobId: savedCommand.jobId,
            generation: 1,
            hostId: savedCommand.hostId,
            disposition: "current" as const,
            issuedAt: now.toISOString(),
          }
          yield* store.recordBatch(
            savedCommand.hostId,
            [
              { deliveryId: "saved-fence", data: yield* encodeRemoteFence(fence), message: fence },
              {
                deliveryId: "saved-command",
                data: yield* encodeRemoteCommand(savedCommand),
                message: savedCommand,
              },
            ],
            now,
          )
          yield* store.executeProbe(savedCommand, now)
          yield* Effect.tryPromise(() => docker("kill", "--signal", "KILL", container))
          const loop = yield* runRemoteRunnerLoop(savedCommand.hostId, {
            outboxRetryIntervalMs: 50,
          }).pipe(Effect.forkScoped)
          yield* Effect.sleep(250)
          yield* Effect.tryPromise(() => docker("start", container))
          yield* Effect.sleep(3_000)
          const deliveries = yield* transport.takeResults(10_000)
          const decoded = yield* decodeRemoteResult(deliveries[0]!.data)
          yield* deliveries[0]!.acknowledge
          yield* Fiber.interrupt(loop)
          return decoded
        }),
      )

      expect(published).toMatchObject({
        resultId: "result-saved-idle-result",
        commandId: "saved-idle-result",
      })
    } finally {
      await docker("start", container).catch(() => undefined)
      await removeDatabase(filename)
    }
  }, 30_000)

  test("old-first queued delivery is rejected after a coordinator currentness fence", async () => {
    const filename = database()
    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const store = yield* RemoteRunnerStore
          yield* transport.ensureInfrastructure()
          yield* transport.publishCommand(command("old-command", 1))
          yield* transport.publishFence({
            version: 1,
            kind: "fence",
            jobId: "generation-job",
            generation: 2,
            hostId: "host-generation",
            disposition: "current",
            issuedAt: now.toISOString(),
          })
          yield* transport.publishCommand(command("current-command", 2))
          const iteration = yield* runRemoteRunnerIteration("host-generation", now)
          return {
            iteration,
            old: yield* store.readCommand("old-command"),
            current: yield* store.readCommand("current-command"),
          }
        }),
      )

      expect(result.iteration).toMatchObject({ status: "executed", commandId: "current-command" })
      expect(result.old).toMatchObject({ state: "rejected", executionCount: 0 })
      expect(result.current).toMatchObject({ state: "result_published", executionCount: 1 })
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("restart recovers durable receipt then consumes outstanding redelivery as duplicate", async () => {
    const filename = database()
    let durableBeforeAck = false
    try {
      const interrupted = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const store = yield* RemoteRunnerStore
          yield* transport.ensureInfrastructure()
          yield* transport.publishFence({
            version: 1,
            kind: "fence",
            jobId: "restart-job",
            generation: 1,
            hostId: "host-restart",
            disposition: "current",
            issuedAt: now.toISOString(),
          })
          yield* transport.publishCommand({
            ...command("restart-command", 1),
            jobId: "restart-job",
            hostId: "host-restart",
          })
          return yield* runRemoteRunnerIteration("host-restart", now, {
            afterDurableReceipt: () =>
              store.readCommand("restart-command").pipe(
                Effect.tap((record) => {
                  durableBeforeAck = record?.state === "received"
                }),
                Effect.zipRight(Effect.fail(new Error("simulated stop"))),
              ),
          }).pipe(Effect.exit)
        }),
      )
      expect(interrupted._tag).toBe("Failure")
      expect(durableBeforeAck).toBe(true)

      const recovered = await run(
        filename,
        runRemoteRunnerIteration("host-restart", new Date(now.getTime() + 1_000)),
      )
      expect(recovered).toMatchObject({
        status: "recovered",
        commandId: "restart-command",
        consumedRedelivery: true,
      })

      const state = await run(
        filename,
        Effect.gen(function* () {
          const store = yield* RemoteRunnerStore
          return yield* store.readCommand("restart-command")
        }),
      )
      expect(state).toMatchObject({ state: "result_published", executionCount: 1 })
    } finally {
      await removeDatabase(filename)
    }
  }, 30_000)

  test("wrong-host, malformed, expired, and distinct-ID conflicts are durable before ack", async () => {
    const filename = database()
    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const store = yield* RemoteRunnerStore
          yield* transport.ensureInfrastructure()
          const subject = "workflowd.v1.commands.host-poison"
          yield* transport.publishRaw(
            subject,
            yield* encodeRemoteCommand({
              ...command("wrong-host", 99),
              jobId: "conflict-job",
              hostId: "other-host",
            }),
          )
          yield* transport.publishRaw(subject, new TextEncoder().encode("{"))
          yield* transport.publishCommand({
            ...command("expired", 99),
            jobId: "conflict-job",
            hostId: "host-poison",
            expiresAt: new Date(now.getTime() - 1).toISOString(),
          })
          yield* transport.publishFence({
            version: 1,
            kind: "fence",
            jobId: "conflict-job",
            generation: 1,
            hostId: "host-poison",
            disposition: "current",
            issuedAt: now.toISOString(),
          })
          yield* transport.publishCommand({
            ...command("chosen-id", 1),
            jobId: "conflict-job",
            hostId: "host-poison",
          })
          yield* transport.publishCommand({
            ...command("unfenced", 1),
            jobId: "unfenced-job",
            hostId: "host-poison",
          })
          yield* transport.publishCommand({
            ...command("distinct-id", 1),
            jobId: "conflict-job",
            hostId: "host-poison",
          })
          yield* runRemoteRunnerIteration("host-poison", now)
          const dispositions = yield* store.readDeliveryDispositions()
          const second = yield* runRemoteRunnerIteration("host-poison", now)
          return { dispositions, second }
        }),
      )

      expect(result.dispositions).toEqual([
        "wrong_host",
        "malformed",
        "expired",
        "fence",
        "received",
        "stale",
        "conflict",
      ])
      expect(result.second).toMatchObject({ status: "idle" })
    } finally {
      await removeDatabase(filename)
    }
  }, 30_000)
})
