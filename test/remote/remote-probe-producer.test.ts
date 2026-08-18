import { expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelJobStore } from "../../src/kernel/job-store"
import { RemoteProbeProducer, RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { now, runKernel } from "../kernel/job-store-harness"

test("probe producer creates a legitimate versioned kernel job through event and wait machinery", async () => {
  const result = await runKernel(
    ":memory:",
    Effect.gen(function* () {
      const producer = yield* RemoteProbeProducer
      const jobs = yield* KernelJobStore
      const submitted = yield* producer.enqueue(
        { probeId: "probe-ingress-1", hostId: "host-a" },
        now,
      )
      const ordinary = yield* jobs.claimNext({
        workerId: "ordinary",
        now,
        leaseDurationMs: 60_000,
      })
      const remote = yield* jobs.claimRemoteProbe({
        workerId: "remote-coordinator",
        now,
        leaseDurationMs: 60_000,
      })
      return { submitted, ordinary, remote }
    }).pipe(Effect.provide(RemoteProbeProducerLive)),
  )

  expect(result.submitted).toMatchObject({
    status: "enqueued",
    jobId: "remote-probe-probe-ingress-1",
  })
  expect(result.ordinary).toBeNull()
  expect(result.remote).toMatchObject({
    jobId: "remote-probe-probe-ingress-1",
    inputVersion: 1,
    input: { kind: "remote_probe", hostId: "host-a" },
  })
})

test("probe producer is idempotent and rejects a changed host for the same probe identity", async () => {
  const result = await runKernel(
    ":memory:",
    Effect.gen(function* () {
      const producer = yield* RemoteProbeProducer
      const first = yield* producer.enqueue({ probeId: "stable-id", hostId: "host-a" }, now)
      const duplicate = yield* producer.enqueue({ probeId: "stable-id", hostId: "host-a" }, now)
      const conflict = yield* producer
        .enqueue({ probeId: "stable-id", hostId: "host-b" }, now)
        .pipe(Effect.either)
      return { first, duplicate, conflict }
    }).pipe(Effect.provide(RemoteProbeProducerLive)),
  )

  expect(result.first.status).toBe("enqueued")
  expect(result.duplicate.status).toBe("duplicate")
  expect(result.conflict._tag).toBe("Left")
})
