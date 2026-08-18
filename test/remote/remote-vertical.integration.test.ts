import { afterAll, beforeAll, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Scope } from "effect"
import { KernelJobStore, type KernelJobStorePort } from "../../src/kernel/job-store"
import {
  RemoteCoordinatorStore,
  RemoteCoordinatorStoreLive,
  type RemoteCoordinatorStorePort,
} from "../../src/remote/coordinator-store"
import { runRemoteDispatchIteration, runRemoteResultIteration } from "../../src/remote/coordinator"
import {
  RemoteProbeProducer,
  RemoteProbeProducerLive,
  type RemoteProbeProducerPort,
} from "../../src/remote/probe-producer"
import { runRemoteRunnerIteration } from "../../src/remote/runner"
import {
  RemoteRunnerStore,
  RemoteRunnerStoreLive,
  type RemoteRunnerStorePort,
} from "../../src/remote/runner-store"
import {
  RemoteTransport,
  RemoteTransportLive,
  type RemoteTransportPort,
} from "../../src/remote/transport"
import { kernelLayer, now, removeDatabase } from "../kernel/job-store-harness"

const container = `workflowd-nats-vertical-${process.pid}`
const port = 48_000 + (process.pid % 500)
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

type CentralServices =
  | KernelJobStorePort
  | RemoteCoordinatorStorePort
  | RemoteProbeProducerPort
  | RemoteTransportPort
  | Scope.Scope

const runCentral = <A, E>(filename: string, effect: Effect.Effect<A, E, CentralServices>) => {
  const kernel = kernelLayer(filename)
  const services = Layer.merge(RemoteCoordinatorStoreLive, RemoteProbeProducerLive).pipe(
    Layer.provideMerge(kernel),
  )
  return Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(Layer.merge(services, RemoteTransportLive({ servers: [server] }))),
      ),
    ),
  )
}

const runRunner = <A, E>(
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
    ),
  )

test("canonical offline probe completes once through duplicate real NATS delivery", async () => {
  const central = `${process.cwd()}/remote-vertical-central-${crypto.randomUUID()}.sqlite`
  const runner = `${process.cwd()}/remote-vertical-runner-${crypto.randomUUID()}.sqlite`
  try {
    const dispatch = await runCentral(
      central,
      Effect.gen(function* () {
        const producer = yield* RemoteProbeProducer
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        yield* producer.enqueue({ probeId: "vertical", hostId: "host-vertical" }, now)
        const iteration = yield* runRemoteDispatchIteration({
          commandId: () => "vertical-command",
          workerId: "coordinator",
          now: () => now,
          leaseDurationMs: 1_000,
          commandTtlMs: 60_000,
        })
        const item = iteration.dispatch!
        yield* transport.publishFence({
          version: 1,
          kind: "fence",
          jobId: item.jobId,
          generation: item.generation,
          hostId: item.hostId,
          disposition: "current",
          issuedAt: item.issuedAt.toISOString(),
        })
        yield* transport.publishCommand({
          version: 1,
          commandId: item.commandId,
          jobId: item.jobId,
          attempt: item.attempt,
          generation: item.generation,
          hostId: item.hostId,
          kind: "probe",
          issuedAt: item.issuedAt.toISOString(),
          expiresAt: item.expiresAt.toISOString(),
        })
        return item
      }),
    )

    const runnerOutcome = await runRunner(
      runner,
      Effect.gen(function* () {
        const store = yield* RemoteRunnerStore
        const outcome = yield* runRemoteRunnerIteration(
          "host-vertical",
          new Date(now.getTime() + 100),
        )
        return { outcome, state: yield* store.readCommand("vertical-command") }
      }),
    )
    expect(runnerOutcome.outcome).toMatchObject({ status: "executed" })
    expect(runnerOutcome.state).toMatchObject({ executionCount: 1, state: "result_published" })

    const completed = await runCentral(
      central,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        const coordinator = yield* RemoteCoordinatorStore
        const jobs = yield* KernelJobStore
        const first = yield* runRemoteResultIteration(new Date(now.getTime() + 200))
        yield* transport.publishResult({
          version: 1,
          resultId: "result-vertical-command",
          commandId: dispatch.commandId,
          jobId: dispatch.jobId,
          attempt: dispatch.attempt,
          generation: dispatch.generation,
          hostId: dispatch.hostId,
          kind: "probe",
          status: "succeeded",
          observedAt: new Date(now.getTime() + 100).toISOString(),
        })
        const duplicate = yield* runRemoteResultIteration(new Date(now.getTime() + 300))
        return {
          first,
          duplicate,
          job: yield* jobs.readJob(dispatch.jobId),
          result: yield* jobs.readResult(dispatch.jobId),
          inbox: yield* coordinator.readInbox(),
        }
      }),
    )

    expect(completed.first.dispositions).toEqual(["accepted"])
    expect(completed.duplicate.dispositions).toEqual(["duplicate"])
    expect(completed.job).toMatchObject({ state: "succeeded", attempt: 1 })
    expect(completed.result).toMatchObject({ resultId: "result-vertical-command" })
    expect(completed.inbox.map(({ disposition }) => disposition)).toEqual(["accepted", "duplicate"])
  } finally {
    await Promise.all([removeDatabase(central), removeDatabase(runner)])
  }
}, 30_000)
