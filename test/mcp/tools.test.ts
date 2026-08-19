import { expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import { KernelJobStore } from "../../src/kernel/job-store"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { McpQueriesLive } from "../../src/mcp/queries"
import { callTool, type ToolCallContext } from "../../src/mcp/tools"
import { kernelLayer, now } from "../kernel/job-store-harness"

const mcpLayer = Layer.merge(RemoteProbeProducerLive, McpQueriesLive).pipe(
  Layer.provideMerge(kernelLayer(":memory:")),
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof mcpLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(mcpLayer)))

const authorized: ToolCallContext = {
  writesConfigured: true,
  writesAuthorized: true,
  now: () => now,
}

const firstText = (result: { content: Array<{ type: "text"; text: string }> }) =>
  result.content[0]!.text

const decodeJson = <A, I>(schema: Schema.Schema<A, I>, text: string): A =>
  Schema.decodeUnknownSync(Schema.parseJson(schema))(text)

const JobStatusJson = Schema.Struct({
  jobId: Schema.String,
  state: Schema.String,
  result: Schema.NullOr(Schema.Struct({ completedAt: Schema.String, result: Schema.Unknown })),
})
const JobListJson = Schema.Struct({
  jobs: Schema.Array(Schema.Struct({ jobId: Schema.String })),
})
const HostHealthJson = Schema.Struct({
  hosts: Schema.Array(
    Schema.Struct({
      hostId: Schema.String,
      dispatchCount: Schema.Number,
      pendingDispatches: Schema.Number,
      lastIssuedAt: Schema.NullOr(Schema.String),
      lastPublishedAt: Schema.NullOr(Schema.String),
      lastResultAt: Schema.NullOr(Schema.String),
      lastDispatchState: Schema.NullOr(Schema.String),
      consumerLiveness: Schema.String,
    }),
  ),
})

test("enqueue_probe acks immediately with the durable job id and the fire-and-ack contract", async () => {
  const result = await run(
    callTool("enqueue_probe", { host: "host-a", probe_id: "ack-shape" }, authorized),
  )

  expect(result.isError).toBeUndefined()
  const text = firstText(result)
  expect(text).toContain("Received: probe ack-shape accepted as durable job remote-probe-ack-shape")
  expect(text).toContain("host host-a")
  expect(text).toContain("End your turn now")
  expect(text).toContain("no blocking wait exists")
  expect(text).toContain('job_status ("remote-probe-ack-shape")')
})

test("enqueue_probe with the same probe_id is idempotent and says so", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* callTool("enqueue_probe", { host: "host-a", probe_id: "stable" }, authorized)
      return yield* callTool("enqueue_probe", { host: "host-a", probe_id: "stable" }, authorized)
    }),
  )

  expect(result.isError).toBeUndefined()
  expect(firstText(result)).toContain("Already received: probe stable")
})

test("enqueue_probe generates a probe identity when none is given", async () => {
  const result = await run(callTool("enqueue_probe", { host: "host-a" }, authorized))

  expect(result.isError).toBeUndefined()
  expect(firstText(result)).toMatch(/durable job remote-probe-mcp-\d{8}T\d{6}-[0-9a-f]+/)
})

test("enqueue_probe refuses when the server has no token configured", async () => {
  const result = await run(
    callTool(
      "enqueue_probe",
      { host: "host-a" },
      { writesConfigured: false, writesAuthorized: false, now: () => now },
    ),
  )

  expect(result.isError).toBe(true)
  expect(firstText(result)).toContain("writes are disabled")
})

test("enqueue_probe refuses an unauthorized caller when a token is configured", async () => {
  const result = await run(
    callTool(
      "enqueue_probe",
      { host: "host-a" },
      { writesConfigured: true, writesAuthorized: false, now: () => now },
    ),
  )

  expect(result.isError).toBe(true)
  expect(firstText(result)).toContain("unauthorized")
})

test("enqueue_probe rejects malformed hosts and probe identities in-band", async () => {
  const badHost = await run(callTool("enqueue_probe", { host: "not a host!" }, authorized))
  const badProbe = await run(
    callTool("enqueue_probe", { host: "host-a", probe_id: "-leading-dash" }, authorized),
  )

  expect(badHost.isError).toBe(true)
  expect(badProbe.isError).toBe(true)
  expect(firstText(badHost)).toContain("invalid arguments")
})

test("job_status reports the durable job state and its result once completed", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* callTool("enqueue_probe", { host: "host-a", probe_id: "status-probe" }, authorized)
      const pending = yield* callTool(
        "job_status",
        { job_id: "remote-probe-status-probe" },
        authorized,
      )
      const jobs = yield* KernelJobStore
      const claim = yield* jobs.claimRemoteProbe({
        workerId: "coordinator",
        now,
        leaseDurationMs: 60_000,
      })
      if (claim === null) return yield* Effect.die(new Error("expected a claimable probe"))
      yield* jobs.complete({
        jobId: claim.jobId,
        workerId: claim.workerId,
        attempt: claim.attempt,
        claimToken: claim.claimToken,
        expectedLeaseUntil: claim.leaseUntil,
        now: new Date(now.getTime() + 1_000),
        resultId: `${claim.jobId}:result`,
        resultVersion: 1,
        result: { kind: "probe", status: "succeeded" },
      })
      const completed = yield* callTool(
        "job_status",
        { job_id: "remote-probe-status-probe" },
        authorized,
      )
      return { pending, completed }
    }),
  )

  const pending = decodeJson(JobStatusJson, firstText(result.pending))
  expect(pending).toMatchObject({
    jobId: "remote-probe-status-probe",
    state: "ready",
    result: null,
  })
  const completed = decodeJson(JobStatusJson, firstText(result.completed))
  expect(completed.jobId).toBe("remote-probe-status-probe")
  expect(completed.state).toBe("succeeded")
  expect(completed.result?.result).toEqual({ kind: "probe", status: "succeeded" })
})

test("job_status reports a missing job and bad arguments in-band", async () => {
  const missing = await run(callTool("job_status", { job_id: "no-such-job" }, authorized))
  const malformed = await run(callTool("job_status", {}, authorized))

  expect(missing.isError).toBe(true)
  expect(firstText(missing)).toContain("no job found with id no-such-job")
  expect(malformed.isError).toBe(true)
})

test("list_recent_jobs returns newest-first durable rows and bounds the limit", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* callTool("enqueue_probe", { host: "host-a", probe_id: "list-one" }, authorized)
      yield* callTool("enqueue_probe", { host: "host-b", probe_id: "list-two" }, authorized)
      const listed = yield* callTool("list_recent_jobs", { limit: 1 }, authorized)
      const defaulted = yield* callTool("list_recent_jobs", undefined, authorized)
      const invalid = yield* callTool("list_recent_jobs", { limit: 0 }, authorized)
      return { listed, defaulted, invalid }
    }),
  )

  const listed = decodeJson(JobListJson, firstText(result.listed))
  expect(listed.jobs).toHaveLength(1)
  const defaulted = decodeJson(JobListJson, firstText(result.defaulted))
  expect(defaulted.jobs.map((job) => job.jobId).sort()).toEqual([
    "remote-probe-list-one",
    "remote-probe-list-two",
  ])
  expect(result.invalid.isError).toBe(true)
})

test("host_health derives per-host liveness from durable dispatch rows only", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* callTool("enqueue_probe", { host: "host-a", probe_id: "health-a" }, authorized)
      yield* callTool("enqueue_probe", { host: "host-b", probe_id: "health-b" }, authorized)
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO kernel_remote_dispatches (
          command_id, job_id, attempt, generation, host_id, worker_id, claim_token,
          lease_until, state, issued_at, expires_at, publish_started_at, published_at,
          completed_at
        ) VALUES (
          'command-a', 'remote-probe-health-a', 1, 1, 'host-a', 'coordinator', 'claim-a',
          '2026-08-12T10:01:00.000Z', 'completed', '2026-08-12T10:00:00.000Z',
          '2026-08-12T10:05:00.000Z', '2026-08-12T10:00:01.000Z', '2026-08-12T10:00:02.000Z',
          '2026-08-12T10:00:03.000Z'
        )`
      yield* sql`INSERT INTO kernel_remote_dispatches (
          command_id, job_id, attempt, generation, host_id, worker_id, claim_token,
          lease_until, state, issued_at, expires_at, publish_started_at, published_at,
          completed_at
        ) VALUES (
          'command-b', 'remote-probe-health-b', 1, 1, 'host-b', 'coordinator', 'claim-b',
          '2026-08-12T10:01:00.000Z', 'published', '2026-08-12T10:00:00.000Z',
          '2026-08-12T10:05:00.000Z', '2026-08-12T10:00:01.000Z', '2026-08-12T10:00:02.000Z',
          NULL
        )`
      return yield* callTool("host_health", {}, authorized)
    }),
  )

  const health = decodeJson(HostHealthJson, firstText(result))
  expect(health.hosts).toEqual([
    {
      hostId: "host-a",
      dispatchCount: 1,
      pendingDispatches: 0,
      lastIssuedAt: "2026-08-12T10:00:00.000Z",
      lastPublishedAt: "2026-08-12T10:00:02.000Z",
      lastResultAt: "2026-08-12T10:00:03.000Z",
      lastDispatchState: "completed",
      consumerLiveness: "responding",
    },
    {
      hostId: "host-b",
      dispatchCount: 1,
      pendingDispatches: 1,
      lastIssuedAt: "2026-08-12T10:00:00.000Z",
      lastPublishedAt: "2026-08-12T10:00:02.000Z",
      lastResultAt: null,
      lastDispatchState: "published",
      consumerLiveness: "pending-work",
    },
  ])
})

test("unknown tools fail in-band instead of crashing the transport", async () => {
  const result = await run(callTool("does_not_exist", {}, authorized))

  expect(result.isError).toBe(true)
  expect(firstText(result)).toContain("unknown tool")
})
