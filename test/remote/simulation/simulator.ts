import { SqlClient } from "@effect/sql"
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { KernelJobStore, type KernelJobStorePort } from "../../../src/kernel/job-store"
import { encodeRemoteCommand } from "../../../src/remote/codec"
import {
  RemoteCoordinatorStoreLive,
  type RemoteCoordinatorStorePort,
} from "../../../src/remote/coordinator-store"
import {
  runRemoteDispatchIteration,
  runRemoteResultIteration,
} from "../../../src/remote/coordinator"
import {
  RemoteProbeProducer,
  RemoteProbeProducerLive,
  type RemoteProbeProducerPort,
} from "../../../src/remote/probe-producer"
import { runRemoteRunnerIteration } from "../../../src/remote/runner"
import { RemoteRunnerStoreLive, type RemoteRunnerStorePort } from "../../../src/remote/runner-store"
import { RemoteTransport, type RemoteTransportPort } from "../../../src/remote/transport"
import { kernelLayer, removeDatabase } from "../../kernel/job-store-harness"
import {
  generateActions,
  minimizeActions,
  replayTrace,
  type SimHost,
  type SimulationAction,
} from "./generator"
import { makeDeterministicTransport, type DeterministicTransport } from "./transport"

type CentralServices =
  | KernelJobStorePort
  | RemoteCoordinatorStorePort
  | RemoteProbeProducerPort
  | RemoteTransportPort
  | SqlClientService

type RunnerServices = RemoteRunnerStorePort | RemoteTransportPort | SqlClientService

const oppositeHost = (host: SimHost): SimHost => (host === "runner-a" ? "runner-b" : "runner-a")

type TerminalRow = {
  readonly state: string
  readonly attempt: number
  readonly failure_json: string | null
  readonly result_id: string | null
  readonly result_json: string | null
}

const terminalSignature = (row: TerminalRow) => {
  if (row.state === "succeeded") return `succeeded:${row.result_id}:${row.result_json}`
  if (row.state === "failed") return `failed:${row.attempt}:${row.failure_json}`
  return undefined
}

export type SimulationSummary = {
  readonly accepted: number
  readonly succeeded: number
  readonly failed: number
  readonly terminal: number
  readonly executions: number
  readonly stale: number
  readonly wrongHost: number
  readonly latestAttempt: number
  readonly fences: number
  readonly staleResults: number
  readonly expiredLeases: number
  readonly duplicates: number
}

export class RemoteSimulation implements AsyncDisposable {
  readonly #centralDatabase: string
  readonly #runnerDatabases: Readonly<Record<SimHost, string>>
  readonly #transport: DeterministicTransport
  readonly #accepted = new Map<string, SimHost>()
  readonly #terminal = new Map<string, string>()
  readonly #cursors = new Map<string, number>()
  #milliseconds = Date.parse("2026-08-18T00:00:00.000Z")
  #nextProbe = 1
  #nextCommand = 1

  private constructor(
    readonly seed: number,
    prefix: string,
    options: { readonly singleMessageBatches?: boolean },
  ) {
    this.#centralDatabase = `${prefix}-central.sqlite`
    this.#runnerDatabases = {
      "runner-a": `${prefix}-runner-a.sqlite`,
      "runner-b": `${prefix}-runner-b.sqlite`,
    }
    this.#transport = makeDeterministicTransport(options)
  }

  static async make(seed: number, options: { readonly singleMessageBatches?: boolean } = {}) {
    const prefix = `${process.cwd()}/remote-simulation-${process.pid}-${crypto.randomUUID()}`
    return new RemoteSimulation(seed, prefix, options)
  }

  readonly #now = () => new Date(this.#milliseconds)

  readonly #runCentral = <A, E>(effect: Effect.Effect<A, E, CentralServices>) => {
    const kernel = kernelLayer(this.#centralDatabase)
    const stores = Layer.merge(RemoteCoordinatorStoreLive, RemoteProbeProducerLive).pipe(
      Layer.provideMerge(kernel),
    )
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.merge(stores, Layer.succeed(RemoteTransport, this.#transport.port))),
      ),
    )
  }

  readonly #runRunner = <A, E>(host: SimHost, effect: Effect.Effect<A, E, RunnerServices>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(RemoteRunnerStoreLive),
        Effect.provide(SqliteClient.layer({ filename: this.#runnerDatabases[host] })),
        Effect.provideService(RemoteTransport, this.#transport.port),
      ),
    )

  async #enqueue(host: SimHost) {
    const probeId = `sim-${this.seed}-${this.#nextProbe++}`
    const jobId = `remote-probe-${probeId}`
    await this.#runCentral(
      Effect.gen(this, function* () {
        const producer = yield* RemoteProbeProducer
        yield* producer.enqueue({ probeId, hostId: host }, this.#now())
      }),
    )
    this.#accepted.set(jobId, host)
  }

  async #coordinator() {
    const commandId = `sim-command-${this.seed}-${this.#nextCommand++}`
    await this.#runCentral(
      Effect.gen(this, function* () {
        yield* runRemoteDispatchIteration({
          commandId: () => commandId,
          workerId: "sim-coordinator",
          now: this.#now,
          leaseDurationMs: 500,
          commandTtlMs: 1_000,
        })
        yield* runRemoteResultIteration(this.#now())
      }).pipe(Effect.catchTag("RemoteTransportError", () => Effect.void)),
    )
  }

  async #runner(host: SimHost) {
    await this.#runRunner(host, runRemoteRunnerIteration(host, this.#now()))
  }

  async #injectWrongHost() {
    const injected = await this.#runCentral(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{
          readonly command_id: string
          readonly job_id: string
          readonly attempt: number
          readonly generation: number
          readonly host_id: SimHost
          readonly issued_at: string
          readonly expires_at: string
        }>`SELECT command_id, job_id, attempt, generation, host_id, issued_at, expires_at
          FROM kernel_remote_dispatches ORDER BY issued_at DESC, command_id DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return null
        const data = yield* encodeRemoteCommand({
          version: 1,
          commandId: row.command_id,
          jobId: row.job_id,
          attempt: row.attempt,
          generation: row.generation,
          hostId: row.host_id,
          kind: "probe",
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
        })
        return {
          data,
          target: oppositeHost(row.host_id),
        }
      }),
    )
    if (injected !== null) this.#transport.injectHost(injected.target, injected.data)
  }

  async #injectStaleResult() {
    const result = await this.#runCentral(
      Effect.gen(this, function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{
          readonly command_id: string
          readonly job_id: string
          readonly attempt: number
          readonly generation: number
          readonly host_id: SimHost
        }>`SELECT command_id, job_id, attempt, generation, host_id
          FROM kernel_remote_dispatches ORDER BY issued_at DESC, command_id DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return null
        return {
          version: 1 as const,
          resultId: `stale-${row.command_id}`,
          commandId: row.command_id,
          jobId: row.job_id,
          attempt: row.attempt,
          generation: row.generation + 1,
          hostId: row.host_id,
          kind: "probe" as const,
          status: "succeeded" as const,
          observedAt: this.#now().toISOString(),
        }
      }),
    )
    if (result !== null) {
      await Effect.runPromise(
        this.#transport.port
          .publishResult(result)
          .pipe(Effect.catchTag("RemoteTransportError", () => Effect.void)),
      )
    }
  }

  async #checkSafety() {
    await this.#runCentral(
      Effect.gen(this, function* () {
        yield* this.#checkAcceptedJobs()
        yield* this.#checkInstanceCursors()
        yield* this.#checkDispatchHandoff()
      }),
    )
    for (const host of ["runner-a", "runner-b"] as const) {
      await this.#runRunner(host, this.#checkRunnerLedgers(host))
    }
  }

  #checkAcceptedJobs() {
    return Effect.gen(this, function* () {
      const jobs = yield* KernelJobStore
      const sql = yield* SqlClient.SqlClient
      for (const jobId of this.#accepted.keys()) {
        const job = yield* jobs.readJob(jobId)
        if (job === null) throw new Error(`accepted work disappeared: ${jobId}`)
        const result = yield* jobs.readResult(jobId)
        const prior = this.#terminal.get(jobId)
        const terminalRows =
          yield* sql<TerminalRow>`SELECT job.state, job.attempt, job.failure_json, result.result_id, result.result_json
          FROM kernel_workflow_jobs AS job
          LEFT JOIN kernel_workflow_job_results AS result ON result.job_id = job.job_id
          WHERE job.job_id = ${jobId}`
        const terminal = terminalSignature(terminalRows[0]!)
        if (job.state === "succeeded" && result === null) {
          throw new Error(`succeeded work lacks result: ${jobId}`)
        }
        if (prior !== undefined && terminal !== prior) {
          throw new Error(`terminal result changed: ${jobId}`)
        }
        if (terminal !== undefined) this.#terminal.set(jobId, terminal)
      }
    })
  }

  #checkInstanceCursors() {
    return Effect.gen(this, function* () {
      const sql = yield* SqlClient.SqlClient
      const cursorViolations = yield* sql<{ readonly job_id: string }>`SELECT job.job_id
        FROM kernel_workflow_jobs AS job
        JOIN kernel_workflow_instances AS instance ON instance.instance_id = job.instance_id
        WHERE job.expected_cursor > instance.event_cursor`
      if (cursorViolations.length > 0) {
        throw new Error(`cursor regressed: ${cursorViolations[0]!.job_id}`)
      }
      const cursors = yield* sql<{ readonly instance_id: string; readonly event_cursor: number }>`
        SELECT instance_id, event_cursor FROM kernel_workflow_instances`
      for (const cursor of cursors) {
        const prior = this.#cursors.get(cursor.instance_id)
        if (prior !== undefined && cursor.event_cursor < prior) {
          throw new Error(`instance cursor moved backwards: ${cursor.instance_id}`)
        }
        this.#cursors.set(cursor.instance_id, cursor.event_cursor)
      }
    })
  }

  #checkDispatchHandoff() {
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const custodyViolations = yield* sql<{ readonly command_id: string }>`
        SELECT dispatch.command_id FROM kernel_remote_dispatches AS dispatch
        JOIN kernel_workflow_jobs AS job ON job.job_id = dispatch.job_id
        WHERE dispatch.state IN ('prepared', 'publishing', 'published') AND (
          job.state <> 'leased' OR job.attempt <> dispatch.attempt OR
          job.lease_worker_id <> dispatch.worker_id OR
          job.claim_token <> dispatch.claim_token OR job.lease_until <> dispatch.lease_until
        )`
      if (custodyViolations.length > 0) {
        throw new Error(`dispatch custody diverged: ${custodyViolations[0]!.command_id}`)
      }
      const inboxViolations = yield* sql<{ readonly delivery_id: string }>`
        SELECT inbox.delivery_id FROM kernel_remote_result_inbox AS inbox
        LEFT JOIN kernel_workflow_job_results AS result ON result.result_id = inbox.result_id
        WHERE inbox.disposition = 'accepted' AND result.result_id IS NULL`
      if (inboxViolations.length > 0) {
        throw new Error(`accepted inbox lacks result: ${inboxViolations[0]!.delivery_id}`)
      }
    })
  }

  #checkRunnerLedgers(host: SimHost) {
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        readonly command_id: string
        readonly execution_count: number
      }>`
        SELECT command_id, execution_count FROM remote_runner_inbox
        WHERE execution_count > 1`
      if (rows.length > 0) throw new Error(`command applied twice: ${rows[0]!.command_id}`)
      const hostViolations = yield* sql<{ readonly command_id: string }>`
        SELECT command_id FROM remote_runner_inbox
        WHERE host_id <> ${host} AND execution_count <> 0`
      if (hostViolations.length > 0) {
        throw new Error(`wrong-host command executed: ${hostViolations[0]!.command_id}`)
      }
      const outboxViolations = yield* sql<{ readonly result_id: string }>`
        SELECT outbox.result_id FROM remote_runner_outbox AS outbox
        JOIN remote_runner_inbox AS inbox ON inbox.command_id = outbox.command_id
        WHERE (outbox.published_at IS NULL AND inbox.state <> 'result_ready')
           OR (outbox.published_at IS NOT NULL AND inbox.state <> 'result_published')`
      if (outboxViolations.length > 0) {
        throw new Error(`runner inbox/outbox diverged: ${outboxViolations[0]!.result_id}`)
      }
    })
  }

  async step(action: SimulationAction) {
    switch (action.type) {
      case "enqueue":
        await this.#enqueue(action.host)
        break
      case "coordinator":
        await this.#coordinator()
        break
      case "runner":
        await this.#runner(action.host)
        break
      case "duplicate":
        this.#transport.duplicate(action.channel)
        break
      case "delay":
        this.#transport.delay(action.channel)
        break
      case "reorder":
        this.#transport.reorder(action.channel)
        break
      case "disconnect":
        this.#transport.disconnect(action.host)
        break
      case "reconnect":
        this.#transport.reconnect(action.host)
        break
      case "advance":
        this.#milliseconds += action.milliseconds
        this.#transport.release("host")
        this.#transport.release("result")
        break
      case "cancel":
        this.#milliseconds += 1_000
        await this.#coordinator()
        break
      case "restart":
        if (action.service === "coordinator") {
          await this.#runCentral(
            Effect.gen(function* () {
              const jobs = yield* KernelJobStore
              yield* jobs.readRecoverable()
            }),
          )
        } else {
          await this.#runRunner(
            action.service,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`SELECT 1 FROM remote_runner_inbox LIMIT 1`
            }),
          )
        }
        break
      case "wrongHost":
        await this.#injectWrongHost()
        break
      case "staleResult":
        await this.#injectStaleResult()
        break
    }
    await this.#checkSafety()
  }

  async run(actions: ReadonlyArray<SimulationAction>) {
    for (const action of actions) await this.step(action)
  }

  async #summary(): Promise<SimulationSummary> {
    const now = this.#now().toISOString()
    const central = await this.#runCentral(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{
          readonly state: string
          readonly count: number
          readonly latest_attempt: number
        }>`SELECT state, COUNT(*) AS count, COALESCE(MAX(attempt), 0) AS latest_attempt
          FROM kernel_workflow_jobs WHERE state IN ('succeeded', 'failed') GROUP BY state`
        const inbox = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM kernel_remote_result_inbox WHERE disposition = 'stale'`
        const expiredLeases = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM kernel_remote_dispatches WHERE lease_until <= ${now}`
        const succeeded = rows.find((row) => row.state === "succeeded")
        const failed = rows.find((row) => row.state === "failed")
        return {
          succeeded: succeeded?.count ?? 0,
          failed: failed?.count ?? 0,
          latestAttempt: Math.max(succeeded?.latest_attempt ?? 0, failed?.latest_attempt ?? 0),
          staleResults: inbox[0]!.count,
          expiredLeases: expiredLeases[0]!.count,
        }
      }),
    )
    let executions = 0
    let stale = 0
    let wrongHost = 0
    let fences = 0
    let duplicates = 0
    for (const host of ["runner-a", "runner-b"] as const) {
      const runner = await this.#runRunner(
        host,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const executionRows = yield* sql<{ readonly count: number }>`
            SELECT COALESCE(SUM(execution_count), 0) AS count FROM remote_runner_inbox`
          const dispositionRows = yield* sql<{
            readonly disposition: string
            readonly count: number
          }>`SELECT disposition, COUNT(*) AS count FROM remote_runner_deliveries
            WHERE disposition IN ('stale', 'wrong_host', 'fence', 'duplicate')
            GROUP BY disposition`
          return { executions: executionRows[0]!.count, dispositions: dispositionRows }
        }),
      )
      executions += runner.executions
      stale += runner.dispositions.find((row) => row.disposition === "stale")?.count ?? 0
      wrongHost += runner.dispositions.find((row) => row.disposition === "wrong_host")?.count ?? 0
      fences += runner.dispositions.find((row) => row.disposition === "fence")?.count ?? 0
      duplicates += runner.dispositions.find((row) => row.disposition === "duplicate")?.count ?? 0
    }
    return {
      accepted: this.#accepted.size,
      succeeded: central.succeeded,
      failed: central.failed,
      terminal: central.succeeded + central.failed,
      executions,
      stale,
      wrongHost,
      latestAttempt: central.latestAttempt,
      fences,
      staleResults: central.staleResults,
      expiredLeases: central.expiredLeases,
      duplicates,
    }
  }

  async quiesce(): Promise<SimulationSummary> {
    for (const endpoint of ["coordinator", "runner-a", "runner-b"] as const) {
      this.#transport.reconnect(endpoint)
    }
    this.#transport.release("host")
    this.#transport.release("result")
    // A drain round retires only a bounded slice of the backlog, so the round
    // budget has to scale with outstanding work rather than being a fixed cap:
    // seed 1 at 500 steps accepts 48 jobs and needs ~35 rounds, which overran
    // the previous fixed cap of 32. Two rounds per accepted job (with a floor
    // for short runs) leaves headroom while still bounding a genuine stall.
    const budget = Math.max(32, this.#accepted.size * 2)
    let last: SimulationSummary | null = null
    for (let index = 0; index < budget; index += 1) {
      await this.#coordinator()
      await this.#runner("runner-a")
      await this.#runner("runner-b")
      await this.#coordinator()
      await this.#checkSafety()
      last = await this.#summary()
      if (last.terminal === last.accepted) return last
    }
    // Keep the first line free of run-specific counts: minimizeSimulationFailure
    // treats it as the failure signature, so varying it per candidate would stop
    // the shrinker recognising smaller reproductions of the same failure.
    throw new Error(
      `seed=${this.seed} did not quiesce\n` +
        `rounds=${budget} accepted=${last?.accepted ?? 0} terminal=${last?.terminal ?? 0}`,
    )
  }

  async [Symbol.asyncDispose]() {
    await Promise.all([
      removeDatabase(this.#centralDatabase),
      removeDatabase(this.#runnerDatabases["runner-a"]),
      removeDatabase(this.#runnerDatabases["runner-b"]),
    ])
  }
}

export const minimizeSimulationFailure = async (
  seed: number,
  actions: ReadonlyArray<SimulationAction>,
  options: { readonly singleMessageBatches?: boolean } = {},
) => {
  const failureSignature = (cause: unknown) =>
    cause instanceof Error ? cause.message.split("\n", 1)[0]! : String(cause)
  const runCandidate = async (candidate: ReadonlyArray<SimulationAction>) => {
    const simulation = await RemoteSimulation.make(seed, options)
    try {
      await simulation.run(candidate)
      await simulation.quiesce()
      return null
    } catch (cause) {
      return failureSignature(cause)
    } finally {
      await simulation[Symbol.asyncDispose]()
    }
  }
  const signature = await runCandidate(actions)
  if (signature === null) throw new Error("cannot minimize a passing simulation")
  return minimizeActions(
    actions,
    async (candidate) => (await runCandidate(candidate)) === signature,
  )
}

export const runSimulationSeed = async (seed: number, length: number) => {
  const actions = generateActions(seed, length)
  await using simulation = await RemoteSimulation.make(seed)
  try {
    await simulation.run(actions)
    return await simulation.quiesce()
  } catch (cause) {
    const minimal = await minimizeSimulationFailure(seed, actions)
    const truncation = minimal.truncated
      ? ` (shrinking truncated after ${minimal.candidates} candidates; reduction is best-so-far, not minimal)`
      : ""
    throw new Error(
      `simulation failed ${replayTrace(seed, actions)} ` +
        `minimal=${replayTrace(seed, minimal.actions)}${truncation}`,
      { cause },
    )
  }
}
