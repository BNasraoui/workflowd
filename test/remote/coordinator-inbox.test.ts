import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  RemoteCoordinatorStore,
  RemoteCoordinatorStoreLive,
  type RemoteCoordinatorStorePort,
} from "../../src/remote/coordinator-store"
import { arrangeJob, now, runKernel } from "../kernel/job-store-harness"

const layer = <A, E, R>(effect: Effect.Effect<A, E, R | RemoteCoordinatorStorePort>) =>
  effect.pipe(Effect.provide(RemoteCoordinatorStoreLive))

test("coordinator durably records every result disposition without poison uniqueness loops", async () => {
  const result = await runKernel(
    ":memory:",
    layer(
      Effect.gen(function* () {
        const remote = yield* RemoteCoordinatorStore
        yield* arrangeJob("inbox-job", { kind: "remote_probe", hostId: "host-a" })
        const dispatch = yield* remote.prepareNext({
          commandId: "inbox-command",
          workerId: "coordinator",
          now,
          leaseDurationMs: 1_000,
          ttlMsForKind: () => 60_000,
        })
        if (dispatch === null) return yield* Effect.die(new Error("expected dispatch"))
        yield* remote.markPublishing(dispatch.commandId, now)
        yield* remote.markPublished(dispatch.commandId, now)
        const base = {
          version: 1 as const,
          resultId: "inbox-result",
          commandId: dispatch.commandId,
          jobId: dispatch.jobId,
          attempt: dispatch.attempt,
          generation: dispatch.generation,
          hostId: dispatch.hostId,
          kind: "probe" as const,
          status: "succeeded" as const,
          observedAt: now.toISOString(),
        }
        const wrongHost = yield* remote.acceptDelivery(
          "results:1",
          { ...base, resultId: "wrong-host-result", hostId: "host-b" },
          now,
        )
        const stale = yield* remote.acceptDelivery(
          "results:2",
          { ...base, resultId: "stale-result", attempt: dispatch.attempt + 1 },
          now,
        )
        const accepted = yield* remote.acceptDelivery("results:3", base, now)
        const duplicate = yield* remote.acceptDelivery("results:4", base, now)
        const conflict = yield* remote.acceptDelivery(
          "results:5",
          { ...base, resultId: "distinct-result-id" },
          now,
        )
        const malformed = yield* remote.recordRejectedDelivery({
          deliveryId: "results:6",
          disposition: "malformed",
          payloadSha256: "a".repeat(64),
          payloadBytes: 7,
          receivedAt: now,
        })
        return {
          wrongHost,
          stale,
          accepted,
          duplicate,
          conflict,
          malformed,
          inbox: yield* remote.readInbox(),
        }
      }),
    ),
  )

  expect([
    result.wrongHost,
    result.stale,
    result.accepted,
    result.duplicate,
    result.conflict,
    result.malformed,
  ]).toEqual(["wrong_host", "stale", "accepted", "duplicate", "conflict", "malformed"])
  expect(result.inbox.map(({ deliveryId, disposition }) => ({ deliveryId, disposition }))).toEqual([
    { deliveryId: "results:1", disposition: "wrong_host" },
    { deliveryId: "results:2", disposition: "stale" },
    { deliveryId: "results:3", disposition: "accepted" },
    { deliveryId: "results:4", disposition: "duplicate" },
    { deliveryId: "results:5", disposition: "conflict" },
    { deliveryId: "results:6", disposition: "malformed" },
  ])
})

test("an exact coordinator delivery replay returns its durable disposition", async () => {
  const result = await runKernel(
    ":memory:",
    layer(
      Effect.gen(function* () {
        const remote = yield* RemoteCoordinatorStore
        const input = {
          deliveryId: "results:replay",
          disposition: "malformed" as const,
          payloadSha256: "b".repeat(64),
          payloadBytes: 3,
          receivedAt: now,
        }
        const first = yield* remote.recordRejectedDelivery(input)
        const replay = yield* remote.recordRejectedDelivery(input)
        const changed = yield* remote.recordRejectedDelivery({
          ...input,
          payloadSha256: "c".repeat(64),
          payloadBytes: 4,
        })
        return { first, replay, changed, inbox: yield* remote.readInbox() }
      }),
    ),
  )

  expect(result).toMatchObject({
    first: "malformed",
    replay: "malformed",
    changed: "conflict",
  })
  expect(result.inbox).toHaveLength(1)
  expect(result.inbox[0]).toMatchObject({ disposition: "conflict" })
})

test("global result identity collision across jobs is durably classified conflict", async () => {
  const result = await runKernel(
    ":memory:",
    layer(
      Effect.gen(function* () {
        const remote = yield* RemoteCoordinatorStore
        yield* arrangeJob("result-collision-a", { kind: "remote_probe", hostId: "host-a" })
        const first = yield* remote.prepareNext({
          commandId: "collision-command-a",
          workerId: "coordinator",
          now,
          leaseDurationMs: 1_000,
          ttlMsForKind: () => 60_000,
        })
        if (first === null) return yield* Effect.die(new Error("expected first dispatch"))
        yield* remote.markPublishing(first.commandId, now)
        yield* remote.markPublishing(first.commandId, now)
        yield* remote.markPublished(first.commandId, now)
        yield* remote.acceptDelivery(
          "results:collision-a",
          {
            version: 1,
            resultId: "global-result-id",
            commandId: first.commandId,
            jobId: first.jobId,
            attempt: first.attempt,
            generation: first.generation,
            hostId: first.hostId,
            kind: "probe",
            status: "succeeded",
            observedAt: now.toISOString(),
          },
          now,
        )

        yield* arrangeJob("result-collision-b", { kind: "remote_probe", hostId: "host-b" })
        const second = yield* remote.prepareNext({
          commandId: "collision-command-b",
          workerId: "coordinator",
          now,
          leaseDurationMs: 1_000,
          ttlMsForKind: () => 60_000,
        })
        if (second === null) return yield* Effect.die(new Error("expected second dispatch"))
        yield* remote.markPublishing(second.commandId, now)
        yield* remote.markPublishing(second.commandId, now)
        yield* remote.markPublished(second.commandId, now)
        const collision = yield* remote.acceptDelivery(
          "results:collision-b",
          {
            version: 1,
            resultId: "global-result-id",
            commandId: second.commandId,
            jobId: second.jobId,
            attempt: second.attempt,
            generation: second.generation,
            hostId: second.hostId,
            kind: "probe",
            status: "succeeded",
            observedAt: now.toISOString(),
          },
          now,
        )
        return { collision, inbox: yield* remote.readInbox() }
      }),
    ),
  )

  expect(result.collision).toBe("conflict")
  expect(result.inbox.at(-1)).toMatchObject({
    deliveryId: "results:collision-b",
    disposition: "conflict",
  })
})
