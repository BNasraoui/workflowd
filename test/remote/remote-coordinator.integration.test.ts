import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { KernelJobStore, type KernelJobStorePort } from "../../src/kernel/job-store"
import {
  RemoteCoordinatorStore,
  RemoteCoordinatorStoreLive,
  type RemoteCoordinatorStorePort,
} from "../../src/remote/coordinator-store"
import {
  RemoteCoordinatorLive,
  runRemoteDispatchIteration,
  runRemoteReconciliationIteration,
  runRemoteResultIteration,
} from "../../src/remote/coordinator"
import { decodeRemoteHostMessage } from "../../src/remote/codec"
import { startRemoteCoordinatorWorkers } from "../../src/runtime"
import {
  RemoteProbeProducer,
  RemoteProbeProducerLive,
  type RemoteProbeProducerPort,
} from "../../src/remote/probe-producer"
import {
  RemoteTransport,
  RemoteTransportLive,
  type RemoteTransportPort,
} from "../../src/remote/transport"
import { kernelLayer, now, removeDatabase } from "../kernel/job-store-harness"

const container = `workflowd-nats-coordinator-${process.pid}`
const port = 47_000 + (process.pid % 500)
const server = `nats://127.0.0.1:${port}`

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

const run = <A, E>(
  filename: string,
  effect: Effect.Effect<
    A,
    E,
    | KernelJobStorePort
    | RemoteCoordinatorStorePort
    | RemoteProbeProducerPort
    | RemoteTransportPort
    | SqlClient.SqlClient
    | Scope.Scope
  >,
) => {
  const kernel = kernelLayer(filename)
  const remote = Layer.merge(RemoteCoordinatorStoreLive, RemoteProbeProducerLive).pipe(
    Layer.provideMerge(kernel),
  )
  const live = Layer.merge(remote, RemoteTransportLive({ servers: [server] }))
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(live))))
}

describe.serial("kernel-backed coordinator against real JetStream", () => {
  test("restart publishes a cancellation fence committed before a simulated crash", async () => {
    const filename = `${process.cwd()}/remote-cancellation-outbox-${crypto.randomUUID()}.sqlite`
    try {
      await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const coordinator = yield* RemoteCoordinatorStore
          const transport = yield* RemoteTransport
          yield* transport.ensureInfrastructure()
          yield* producer.enqueue({ probeId: "cancellation-outbox", hostId: "host-outbox" }, now)
          yield* runRemoteDispatchIteration({
            commandId: () => "cancellation-outbox-command",
            workerId: "coordinator-before-crash",
            now: () => now,
            leaseDurationMs: 100,
            commandTtlMs: 100,
          })
          yield* coordinator.reconcileExpired(new Date(now.getTime() + 200))
        }),
      )

      const recovered = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const reconciliation = yield* runRemoteReconciliationIteration(
            new Date(now.getTime() + 300),
          )
          const deliveries = yield* transport.takeHostBatch("host-outbox", 1_000)
          const messages = yield* Effect.forEach(deliveries, (delivery) =>
            decodeRemoteHostMessage(delivery.data).pipe(Effect.tap(() => delivery.acknowledge)),
          )
          return { reconciliation, messages }
        }),
      )

      expect(recovered.reconciliation).toEqual({ retried: 0, terminal: 0 })
      expect(recovered.messages.at(-1)).toMatchObject({
        kind: "fence",
        disposition: "cancelled",
        generation: 2,
      })
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("terminal remote attempt durably publishes its cancellation fence", async () => {
    const filename = `${process.cwd()}/remote-terminal-cancellation-${crypto.randomUUID()}.sqlite`
    try {
      const outcome = await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const transport = yield* RemoteTransport
          const jobs = yield* KernelJobStore
          const sql = yield* SqlClient.SqlClient
          yield* transport.ensureInfrastructure()
          const submitted = yield* producer.enqueue(
            { probeId: "terminal-cancellation", hostId: "host-terminal" },
            now,
          )
          yield* sql`UPDATE kernel_workflow_jobs SET max_attempts = 1
            WHERE job_id = ${submitted.jobId}`
          yield* runRemoteDispatchIteration({
            commandId: () => "terminal-cancellation-command",
            workerId: "terminal-coordinator",
            now: () => now,
            leaseDurationMs: 100,
            commandTtlMs: 100,
          })
          const reconciliation = yield* runRemoteReconciliationIteration(
            new Date(now.getTime() + 200),
          )
          const deliveries = yield* transport.takeHostBatch("host-terminal", 1_000)
          const messages = yield* Effect.forEach(deliveries, (delivery) =>
            decodeRemoteHostMessage(delivery.data).pipe(Effect.tap(() => delivery.acknowledge)),
          )
          return {
            reconciliation,
            messages,
            job: yield* jobs.readJob(submitted.jobId),
          }
        }),
      )

      expect(outcome.reconciliation).toEqual({ retried: 0, terminal: 1 })
      expect(outcome.job).toMatchObject({ state: "failed", attempt: 1 })
      expect(outcome.messages.at(-1)).toMatchObject({
        kind: "fence",
        disposition: "cancelled",
        generation: 2,
      })
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("restart after published expiry supersedes custody and emits a cancelled fence", async () => {
    const filename = `${process.cwd()}/remote-published-expiry-${crypto.randomUUID()}.sqlite`
    try {
      await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const transport = yield* RemoteTransport
          yield* transport.ensureInfrastructure()
          yield* producer.enqueue({ probeId: "published-expiry", hostId: "host-expiry" }, now)
          yield* runRemoteDispatchIteration({
            commandId: () => "expired-published-command",
            workerId: "coordinator-before-downtime",
            now: () => now,
            leaseDurationMs: 100,
            commandTtlMs: 100,
          })
        }),
      )
      const recovered = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const jobs = yield* KernelJobStore
          const reconciliation = yield* runRemoteReconciliationIteration(
            new Date(now.getTime() + 200),
          )
          const deliveries = yield* transport.takeHostBatch("host-expiry", 1_000)
          const decoded = yield* Effect.forEach(deliveries, (delivery) =>
            decodeRemoteHostMessage(delivery.data).pipe(Effect.tap(() => delivery.acknowledge)),
          )
          return {
            reconciliation,
            decoded,
            job: yield* jobs.readJob("remote-probe-published-expiry"),
          }
        }),
      )
      expect(recovered.reconciliation).toMatchObject({ retried: 1, terminal: 0 })
      expect(recovered.decoded.at(-1)).toMatchObject({
        kind: "fence",
        disposition: "cancelled",
        generation: 2,
      })
      expect(recovered.job).toMatchObject({ state: "retry_scheduled", attempt: 1 })
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("expired prepared dispatch is reconciled without publishing its old command", async () => {
    const filename = `${process.cwd()}/remote-prepared-expiry-${crypto.randomUUID()}.sqlite`
    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const coordinator = yield* RemoteCoordinatorStore
          const transport = yield* RemoteTransport
          yield* transport.ensureInfrastructure()
          yield* producer.enqueue({ probeId: "prepared-expiry", hostId: "host-prepared" }, now)
          yield* coordinator.prepareNext({
            commandId: "expired-prepared-command",
            workerId: "coordinator-before-downtime",
            now,
            leaseDurationMs: 100,
            ttlMsForKind: () => 100,
          })
          const iteration = yield* runRemoteDispatchIteration({
            commandId: () => "replacement-command",
            workerId: "coordinator-after-downtime",
            now: () => new Date(now.getTime() + 200),
            leaseDurationMs: 1_000,
            commandTtlMs: 60_000,
          })
          const deliveries = yield* transport.takeHostBatch("host-prepared", 1_000)
          const messages = yield* Effect.forEach(deliveries, (delivery) =>
            decodeRemoteHostMessage(delivery.data).pipe(Effect.tap(() => delivery.acknowledge)),
          )
          return { iteration, messages }
        }),
      )
      expect(
        result.messages.some(
          (message) => "commandId" in message && message.commandId === "expired-prepared-command",
        ),
      ).toBe(false)
      expect(
        result.messages.some(
          (message) => "commandId" in message && message.commandId === "replacement-command",
        ),
      ).toBe(true)
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("result received beyond command expiry is durably rejected", async () => {
    const filename = `${process.cwd()}/remote-result-expiry-${crypto.randomUUID()}.sqlite`
    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const coordinator = yield* RemoteCoordinatorStore
          const transport = yield* RemoteTransport
          const jobs = yield* KernelJobStore
          yield* transport.ensureInfrastructure()
          yield* producer.enqueue({ probeId: "result-expiry", hostId: "host-result-expiry" }, now)
          const dispatched = yield* runRemoteDispatchIteration({
            commandId: () => "result-expiry-command",
            workerId: "coordinator",
            now: () => now,
            leaseDurationMs: 100,
            commandTtlMs: 100,
          })
          const dispatch = dispatched.dispatch!
          yield* transport.publishResult({
            version: 1,
            resultId: "late-result",
            commandId: dispatch.commandId,
            jobId: dispatch.jobId,
            attempt: dispatch.attempt,
            generation: dispatch.generation,
            hostId: dispatch.hostId,
            kind: "probe",
            status: "succeeded",
            observedAt: new Date(now.getTime() + 50).toISOString(),
          })
          const processed = yield* runRemoteResultIteration(new Date(now.getTime() + 101))
          return {
            processed,
            job: yield* jobs.readJob(dispatch.jobId),
            inbox: yield* coordinator.readInbox(),
          }
        }),
      )
      expect(result.processed.dispositions).toEqual(["expired"])
      expect(result.job).toMatchObject({ state: "leased" })
      expect(result.inbox.map(({ disposition }) => disposition)).toEqual(["expired"])
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("matching result arriving before publish confirmation is not lost", async () => {
    const filename = `${process.cwd()}/remote-publish-race-${crypto.randomUUID()}.sqlite`
    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const transport = yield* RemoteTransport
          const jobs = yield* KernelJobStore
          yield* transport.ensureInfrastructure()
          const submitted = yield* producer.enqueue(
            { probeId: "publish-race", hostId: "host-race" },
            now,
          )
          let raceDisposition: ReadonlyArray<string> = []
          const dispatch = yield* runRemoteDispatchIteration({
            commandId: () => "publish-race-command",
            workerId: "coordinator",
            now: () => now,
            leaseDurationMs: 1_000,
            commandTtlMs: 60_000,
            afterBrokerPublish: (prepared) =>
              transport
                .publishResult({
                  version: 1,
                  resultId: "publish-race-result",
                  commandId: prepared.commandId,
                  jobId: prepared.jobId,
                  attempt: prepared.attempt,
                  generation: prepared.generation,
                  hostId: prepared.hostId,
                  kind: "probe",
                  status: "succeeded",
                  observedAt: new Date(now.getTime() + 100).toISOString(),
                })
                .pipe(
                  Effect.andThen(runRemoteResultIteration(new Date(now.getTime() + 200))),
                  Effect.tap((processed) =>
                    Effect.sync(() => {
                      raceDisposition = processed.dispositions
                    }),
                  ),
                  Effect.asVoid,
                ),
          })
          return {
            dispatch,
            raceDisposition,
            job: yield* jobs.readJob(submitted.jobId),
            result: yield* jobs.readResult(submitted.jobId),
          }
        }),
      )

      expect(result.raceDisposition).toEqual(["accepted"])
      expect(result.job).toMatchObject({ state: "succeeded", attempt: 1 })
      expect(result.result).toMatchObject({ resultId: "publish-race-result" })
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("coordinator restart publishes a dispatch durably prepared before broker publication", async () => {
    const filename = `${process.cwd()}/remote-outbox-restart-${crypto.randomUUID()}.sqlite`
    try {
      await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const coordinator = yield* RemoteCoordinatorStore
          const transport = yield* RemoteTransport
          yield* transport.ensureInfrastructure()
          yield* producer.enqueue({ probeId: "outbox-restart", hostId: "host-restart" }, now)
          yield* coordinator.prepareNext({
            commandId: "restart-prepared-command",
            workerId: "coordinator-before-restart",
            now,
            leaseDurationMs: 1_000,
            ttlMsForKind: () => 60_000,
          })
        }),
      )

      const recovered = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const iteration = yield* runRemoteDispatchIteration({
            commandId: () => "unused-new-command",
            workerId: "coordinator-after-restart",
            now: () => new Date(now.getTime() + 100),
            leaseDurationMs: 1_000,
            commandTtlMs: 60_000,
          })
          const fence = yield* transport.takeHost("host-restart", 5_000)
          yield* fence[0]!.acknowledge
          const command = yield* transport.takeHost("host-restart", 5_000)
          yield* command[0]!.acknowledge
          return { iteration, command: new TextDecoder().decode(command[0]!.data) }
        }),
      )

      expect(recovered.iteration).toMatchObject({ dispatch: null, published: 1 })
      expect(JSON.parse(recovered.command)).toMatchObject({
        commandId: "restart-prepared-command",
        attempt: 1,
      })
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("existing central runtime starts real dispatch and result coordinator loops", async () => {
    const filename = `${process.cwd()}/remote-runtime-${crypto.randomUUID()}.sqlite`
    try {
      const observed = await run(
        filename,
        Effect.gen(function* () {
          const transport = yield* RemoteTransport
          const coordinator = yield* RemoteCoordinatorStore
          yield* transport.ensureInfrastructure()
          yield* transport.publishRaw("workflowd.v1.results", new TextEncoder().encode("{"))
          const names = new Set<string>()
          const ready = yield* Deferred.make<void>()
          const workers = yield* startRemoteCoordinatorWorkers(10, (name) =>
            Effect.sync(() => names.add(name)).pipe(
              Effect.tap(() =>
                names.size === 2 ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
              Effect.asVoid,
            ),
          )
          yield* Deferred.await(ready)
          yield* Fiber.interruptAll(workers)
          return { names, inbox: yield* coordinator.readInbox() }
        }).pipe(
          Effect.provide(
            RemoteCoordinatorLive({
              workerId: "runtime-coordinator",
              leaseDurationMs: 60_000,
              commandTtlMs: 300_000,
            }),
          ),
        ),
      )

      expect(observed.names).toEqual(new Set(["remote-dispatch", "remote-result"]))
      expect(observed.inbox.map(({ disposition }) => disposition)).toEqual(["malformed"])
    } finally {
      await removeDatabase(filename)
    }
  }, 20_000)

  test("stale broker result after genuine supersession is fenced and current result completes kernel job", async () => {
    const filename = `${process.cwd()}/remote-coordinator-${crypto.randomUUID()}.sqlite`
    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const producer = yield* RemoteProbeProducer
          const coordinator = yield* RemoteCoordinatorStore
          const transport = yield* RemoteTransport
          const jobs = yield* KernelJobStore
          yield* transport.ensureInfrastructure()
          yield* producer.enqueue({ probeId: "supersession", hostId: "host-a" }, now)

          const first = yield* runRemoteDispatchIteration({
            commandId: () => "command-attempt-1",
            workerId: "coordinator",
            now: () => now,
            leaseDurationMs: 1_000,
            commandTtlMs: 60_000,
          })
          yield* coordinator.supersede("command-attempt-1", new Date(now.getTime() + 1_100))
          const second = yield* runRemoteDispatchIteration({
            commandId: () => "command-attempt-2",
            workerId: "coordinator",
            now: () => new Date(now.getTime() + 1_100),
            leaseDurationMs: 1_000,
            commandTtlMs: 60_000,
          })
          if (first.dispatch === null || second.dispatch === null) {
            return yield* Effect.die(new Error("expected two dispatches"))
          }

          yield* transport.publishResult({
            version: 1,
            resultId: "result-attempt-1",
            commandId: first.dispatch.commandId,
            jobId: first.dispatch.jobId,
            attempt: first.dispatch.attempt,
            generation: first.dispatch.generation,
            hostId: first.dispatch.hostId,
            kind: "probe",
            status: "succeeded",
            observedAt: new Date(now.getTime() + 1_200).toISOString(),
          })
          const stale = yield* runRemoteResultIteration(new Date(now.getTime() + 1_300))
          const beforeCurrent = yield* jobs.readJob(first.dispatch.jobId)

          yield* transport.publishResult({
            version: 1,
            resultId: "result-attempt-2",
            commandId: second.dispatch.commandId,
            jobId: second.dispatch.jobId,
            attempt: second.dispatch.attempt,
            generation: second.dispatch.generation,
            hostId: second.dispatch.hostId,
            kind: "probe",
            status: "succeeded",
            observedAt: new Date(now.getTime() + 1_400).toISOString(),
          })
          const current = yield* runRemoteResultIteration(new Date(now.getTime() + 1_500))
          return {
            first,
            second,
            stale,
            current,
            beforeCurrent,
            job: yield* jobs.readJob(first.dispatch.jobId),
            result: yield* jobs.readResult(first.dispatch.jobId),
            inbox: yield* coordinator.readInbox(),
          }
        }),
      )

      expect(result.first.dispatch).toMatchObject({ attempt: 1, state: "prepared" })
      expect(result.second.dispatch).toMatchObject({ attempt: 2, generation: 2 })
      expect(result.stale.dispositions).toEqual(["stale"])
      expect(result.beforeCurrent).toMatchObject({ state: "leased", attempt: 2 })
      expect(result.current.dispositions).toEqual(["accepted"])
      expect(result.job).toMatchObject({ state: "succeeded", attempt: 2 })
      expect(result.result).toMatchObject({ resultId: "result-attempt-2" })
      expect(result.inbox.map(({ disposition }) => disposition)).toEqual(["stale", "accepted"])
    } finally {
      await removeDatabase(filename)
    }
  }, 30_000)
})
