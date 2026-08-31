import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { KernelJobStore } from "../../src/kernel/job-store"
import {
  RemoteCoordinatorStore,
  RemoteCoordinatorStoreLive,
  type RemoteCoordinatorStorePort,
} from "../../src/remote/coordinator-store"
import { arrangeJob, now, runKernel } from "../kernel/job-store-harness"

const withCoordinator = <A, E, R>(effect: Effect.Effect<A, E, R | RemoteCoordinatorStorePort>) =>
  effect.pipe(Effect.provide(RemoteCoordinatorStoreLive))

test("remote dispatch takes durable custody of a real kernel job and completes it after restart", async () => {
  const filename = `${process.cwd()}/remote-kernel-${crypto.randomUUID()}.sqlite`
  const commandId = crypto.randomUUID()
  try {
    const prepared = await runKernel(
      filename,
      withCoordinator(
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const remote = yield* RemoteCoordinatorStore
          yield* arrangeJob("remote-kernel-job", { kind: "remote_probe", hostId: "host-a" })
          const ordinary = yield* jobs.claimNext({
            workerId: "ordinary-worker",
            now,
            leaseDurationMs: 60_000,
          })
          const dispatch = yield* remote.prepareNext({
            commandId,
            workerId: "remote-coordinator",
            now,
            leaseDurationMs: 1_000,
            ttlMsForKind: () => 60_000,
          })
          return { ordinary, dispatch }
        }),
      ),
    )

    expect(prepared.ordinary).toBeNull()
    expect(prepared.dispatch).toMatchObject({
      commandId,
      jobId: "remote-kernel-job",
      attempt: 1,
      workerId: "remote-coordinator",
      hostId: "host-a",
      state: "prepared",
    })
    expect(prepared.dispatch?.claimToken).toBeString()
    expect(prepared.dispatch?.leaseUntil).toEqual(new Date(now.getTime() + 1_000))

    const completed = await runKernel(
      filename,
      withCoordinator(
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const remote = yield* RemoteCoordinatorStore
          const afterLease = new Date(now.getTime() + 2_000)
          const reclaimed = yield* jobs.claimNext({
            workerId: "ordinary-worker",
            now: afterLease,
            leaseDurationMs: 60_000,
          })
          const recovered = yield* remote.pendingDispatches()
          yield* remote.markPublishing(commandId, new Date(now.getTime() + 100))
          yield* remote.markPublished(commandId, new Date(now.getTime() + 100))
          const accepted = yield* remote.acceptResult(
            {
              version: 1,
              resultId: `result-${commandId}`,
              commandId,
              jobId: "remote-kernel-job",
              attempt: 1,
              generation: 1,
              hostId: "host-a",
              kind: "probe",
              status: "succeeded",
              observedAt: new Date(now.getTime() + 1_500).toISOString(),
            },
            afterLease,
          )
          return {
            reclaimed,
            recovered,
            accepted,
            job: yield* jobs.readJob("remote-kernel-job"),
            result: yield* jobs.readResult("remote-kernel-job"),
          }
        }),
      ),
    )

    expect(completed.reclaimed).toBeNull()
    expect(completed.recovered).toHaveLength(1)
    expect(completed.accepted).toBe("accepted")
    expect(completed.job).toMatchObject({ state: "succeeded", attempt: 1 })
    expect(completed.result).toMatchObject({
      resultId: `result-${commandId}`,
      result: { kind: "remote_probe", hostId: "host-a", status: "succeeded" },
    })
  } finally {
    const { removeDatabase } = await import("../kernel/job-store-harness")
    await removeDatabase(filename)
  }
})

test("remote result fencing rejects a distinct command identity without completing the kernel job", async () => {
  const result = await runKernel(
    ":memory:",
    withCoordinator(
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const remote = yield* RemoteCoordinatorStore
        yield* arrangeJob("remote-fence-job", { kind: "remote_probe", hostId: "host-a" })
        const dispatch = yield* remote.prepareNext({
          commandId: "authoritative-command",
          workerId: "remote-coordinator",
          now,
          leaseDurationMs: 1_000,
          ttlMsForKind: () => 60_000,
        })
        if (dispatch === null) return yield* Effect.die(new Error("expected dispatch"))
        yield* remote.markPublishing(dispatch.commandId, now)
        yield* remote.markPublished(dispatch.commandId, now)
        const disposition = yield* remote.acceptResult(
          {
            version: 1,
            resultId: "conflicting-result",
            commandId: "different-command",
            jobId: dispatch.jobId,
            attempt: dispatch.attempt,
            generation: dispatch.generation,
            hostId: dispatch.hostId,
            kind: "probe",
            status: "succeeded",
            observedAt: now.toISOString(),
          },
          new Date(now.getTime() + 2_000),
        )
        return { disposition, job: yield* jobs.readJob(dispatch.jobId) }
      }),
    ),
  )

  expect(result.disposition).toBe("stale")
  expect(result.job).toMatchObject({ state: "leased" })
})

test("dispatch insertion failure rolls back the remote kernel claim without losing an attempt", async () => {
  const result = await runKernel(
    ":memory:",
    withCoordinator(
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const remote = yield* RemoteCoordinatorStore
        const sql = yield* SqlClient.SqlClient
        yield* arrangeJob("atomic-remote-claim", { kind: "remote_probe", hostId: "host-a" })
        yield* sql`CREATE TRIGGER reject_remote_dispatch
          BEFORE INSERT ON kernel_remote_dispatches
          BEGIN SELECT RAISE(ABORT, 'injected dispatch failure'); END`
        const failed = yield* remote
          .prepareNext({
            commandId: "atomic-command",
            workerId: "coordinator",
            now,
            leaseDurationMs: 60_000,
            ttlMsForKind: () => 60_000,
          })
          .pipe(Effect.result)
        const afterFailure = yield* jobs.readJob("atomic-remote-claim")
        yield* sql`DROP TRIGGER reject_remote_dispatch`
        const retry = yield* remote.prepareNext({
          commandId: "atomic-command",
          workerId: "coordinator",
          now,
          leaseDurationMs: 60_000,
          ttlMsForKind: () => 60_000,
        })
        return { failed, afterFailure, retry }
      }),
    ),
  )

  expect(result.failed._tag).toBe("Failure")
  expect(result.afterFailure).toMatchObject({ state: "ready", attempt: 0 })
  expect(result.retry).toMatchObject({ attempt: 1, commandId: "atomic-command" })
})

test("duplicate command identity rolls back the second job claim", async () => {
  const result = await runKernel(
    ":memory:",
    withCoordinator(
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const remote = yield* RemoteCoordinatorStore
        yield* arrangeJob("command-owner-a", { kind: "remote_probe", hostId: "host-a" })
        yield* arrangeJob("command-owner-b", { kind: "remote_probe", hostId: "host-b" })
        yield* remote.prepareNext({
          commandId: "shared-command-id",
          workerId: "coordinator",
          now,
          leaseDurationMs: 60_000,
          ttlMsForKind: () => 60_000,
        })
        const conflict = yield* remote
          .prepareNext({
            commandId: "shared-command-id",
            workerId: "coordinator",
            now,
            leaseDurationMs: 60_000,
            ttlMsForKind: () => 60_000,
          })
          .pipe(Effect.result)
        const afterConflict = yield* jobs.readJob("command-owner-b")
        const retry = yield* remote.prepareNext({
          commandId: "owner-b-command",
          workerId: "coordinator",
          now,
          leaseDurationMs: 60_000,
          ttlMsForKind: () => 60_000,
        })
        return { conflict, afterConflict, retry }
      }),
    ),
  )

  expect(result.conflict._tag).toBe("Failure")
  expect(result.afterConflict).toMatchObject({ state: "ready", attempt: 0 })
  expect(result.retry).toMatchObject({ jobId: "command-owner-b", attempt: 1 })
})
