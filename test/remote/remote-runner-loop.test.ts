import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Logger, Ref } from "effect"
import { runRemoteRunnerLoop } from "../../src/remote/runner"
import { RemoteRunnerStore, type RemoteRunnerStorePort } from "../../src/remote/runner-store"
import {
  RemoteTransport,
  RemoteTransportError,
  type RemoteTransportPort,
} from "../../src/remote/transport"

const result = {
  version: 1 as const,
  resultId: "result-idle-retry",
  commandId: "idle-retry",
  jobId: "job-idle-retry",
  attempt: 1,
  generation: 1,
  hostId: "host-idle-retry",
  kind: "probe" as const,
  status: "succeeded" as const,
  observedAt: "2026-08-18T12:00:00.000Z",
}

const SilentLogger = Logger.layer([Logger.make(() => undefined)])

describe("remote runner loop", () => {
  test("publishes a durable result after broker recovery without another delivery", async () => {
    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          const published = yield* Deferred.make<void>()
          const store: RemoteRunnerStorePort = {
            recordBatch: () => Effect.succeed([]),
            recoverReceived: () => Effect.succeed([]),
            executeProbe: () => Effect.succeed(result),
            executeClaudeResume: () => Effect.succeed(result),
            pendingResults: () => Effect.succeed([result]),
            markResultPublished: () => Deferred.succeed(published, undefined).pipe(Effect.asVoid),
            readCommand: () => Effect.succeed(null),
            readDeliveryDispositions: () => Effect.succeed([]),
          }
          const transport: RemoteTransportPort = {
            ensureInfrastructure: () => Effect.void,
            publishCommand: () => Effect.void,
            publishFence: () => Effect.void,
            publishResult: () =>
              Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                Effect.flatMap((attempt) =>
                  attempt === 1
                    ? Effect.fail(
                        new RemoteTransportError({
                          operation: "publish",
                          cause: new Error("broker unavailable"),
                        }),
                      )
                    : Effect.void,
                ),
              ),
            publishRaw: () => Effect.void,
            takeHost: () => Effect.succeed([]),
            takeHostBatch: () => Effect.succeed([]),
            takeResults: () => Effect.succeed([]),
            consumeHost: () => Effect.never,
          }
          const loop = yield* runRemoteRunnerLoop("host-idle-retry", {
            outboxRetryIntervalMs: 10,
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(RemoteRunnerStore, store),
                Layer.succeed(RemoteTransport, transport),
              ),
            ),
            Effect.forkScoped,
          )
          const recovered = yield* Effect.race(
            Deferred.await(published).pipe(Effect.as(true)),
            Effect.sleep(250).pipe(Effect.as(false)),
          )
          yield* Fiber.interrupt(loop)
          return recovered
        }),
      ).pipe(Effect.provide(SilentLogger)),
    )

    expect(published).toBe(true)
  })

  test("acknowledges a backlog above max_ack_pending in bounded batches before execution", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstAck = yield* Deferred.make<void>()
          const allAcked = yield* Deferred.make<void>()
          const offered = yield* Ref.make(0)
          const acknowledged = yield* Ref.make(0)
          const batchSizes = yield* Ref.make<ReadonlyArray<number>>([])
          const prematureExecution = yield* Ref.make(false)
          const total = 1_002
          const store: RemoteRunnerStorePort = {
            recordBatch: (_hostId, deliveries) =>
              Ref.update(batchSizes, (sizes) => [...sizes, deliveries.length]).pipe(
                Effect.as(
                  deliveries.map((delivery) => ({
                    deliveryId: delivery.deliveryId,
                    disposition: "malformed",
                  })),
                ),
              ),
            recoverReceived: () =>
              Ref.get(offered).pipe(
                Effect.tap((count) =>
                  count < total ? Ref.set(prematureExecution, true) : Effect.void,
                ),
                Effect.as([]),
              ),
            executeProbe: () => Effect.succeed(result),
            executeClaudeResume: () => Effect.succeed(result),
            pendingResults: () => Effect.succeed([]),
            markResultPublished: () => Effect.void,
            readCommand: () => Effect.succeed(null),
            readDeliveryDispositions: () => Effect.succeed([]),
          }
          const transport: RemoteTransportPort = {
            ensureInfrastructure: () => Effect.void,
            publishCommand: () => Effect.void,
            publishFence: () => Effect.void,
            publishResult: () => Effect.void,
            publishRaw: () => Effect.void,
            takeHost: () => Effect.succeed([]),
            takeHostBatch: () => Effect.succeed([]),
            takeResults: () => Effect.succeed([]),
            consumeHost: (_hostId, handle) =>
              Effect.gen(function* () {
                for (let index = 0; index < total; index += 1) {
                  if (index === 1_000) yield* Deferred.await(firstAck)
                  yield* Ref.set(offered, index + 1)
                  yield* handle({
                    deliveryId: `delivery-${index}`,
                    data: new TextEncoder().encode("{"),
                    pending: total - index - 1,
                    acknowledge: Ref.updateAndGet(acknowledged, (count) => count + 1).pipe(
                      Effect.tap((count) =>
                        count === 1 ? Deferred.succeed(firstAck, undefined) : Effect.void,
                      ),
                      Effect.tap((count) =>
                        count === total ? Deferred.succeed(allAcked, undefined) : Effect.void,
                      ),
                      Effect.as(true),
                    ),
                  })
                }
                return yield* Effect.never
              }),
          }
          const loop = yield* runRemoteRunnerLoop("host-backlog", {
            outboxRetryIntervalMs: 1_000,
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(RemoteRunnerStore, store),
                Layer.succeed(RemoteTransport, transport),
              ),
            ),
            Effect.forkScoped,
          )
          const progressed = yield* Effect.race(
            Deferred.await(allAcked).pipe(Effect.as(true)),
            Effect.sleep(500).pipe(Effect.as(false)),
          )
          const sizes = yield* Ref.get(batchSizes)
          const premature = yield* Ref.get(prematureExecution)
          yield* Fiber.interrupt(loop)
          return { progressed, sizes, premature }
        }),
      ).pipe(Effect.provide(SilentLogger)),
    )

    expect(outcome.progressed).toBe(true)
    expect(Math.max(...outcome.sizes)).toBeLessThanOrEqual(100)
    expect(outcome.premature).toBe(false)
  })
})
