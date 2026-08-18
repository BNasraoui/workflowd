import { Effect, Option, Queue } from "effect"
import { decodeRemoteHostMessage } from "./codec"
import { RemoteRunnerStore, type RemoteRunnerStorePort } from "./runner-store"
import { RemoteTransport } from "./transport"
import type { RemoteDelivery } from "./transport"

export type RemoteRunnerIterationOptions = {
  readonly afterDurableReceipt?: () => Effect.Effect<void, Error, RemoteRunnerStorePort>
}

export type RemoteRunnerLoopOptions = {
  readonly outboxRetryIntervalMs?: number
}

const drainPendingResults = (at: Date) =>
  Effect.gen(function* () {
    const store = yield* RemoteRunnerStore
    const transport = yield* RemoteTransport
    const results = yield* store.pendingResults()
    for (const result of results) {
      yield* transport.publishResult(result)
      yield* store.markResultPublished(result.resultId, at)
    }
  })

const recordRemoteRunnerDeliveries = (
  hostId: string,
  at: Date,
  deliveries: ReadonlyArray<RemoteDelivery>,
  options: RemoteRunnerIterationOptions,
) =>
  Effect.gen(function* () {
    const store = yield* RemoteRunnerStore
    const decoded = yield* Effect.forEach(deliveries, (delivery) =>
      decodeRemoteHostMessage(delivery.data).pipe(
        Effect.match({
          onFailure: (error) => ({
            deliveryId: delivery.deliveryId,
            data: delivery.data,
            rejection: error.reason,
          }),
          onSuccess: (message) => ({
            deliveryId: delivery.deliveryId,
            data: delivery.data,
            message,
          }),
        }),
      ),
    )
    const outcomes = yield* store.recordBatch(hostId, decoded, at)
    if (deliveries.length > 0 && options.afterDurableReceipt !== undefined) {
      yield* options.afterDurableReceipt()
    }
    yield* Effect.forEach(deliveries, (delivery) => delivery.acknowledge, { discard: true })
    return outcomes
  })

const executeReceivedAndDrainResults = (at: Date, drainResults = true) =>
  Effect.gen(function* () {
    const store = yield* RemoteRunnerStore
    const recoverable = yield* store.recoverReceived()
    for (const command of recoverable) yield* store.executeProbe(command, at)
    if (drainResults) yield* drainPendingResults(at)
    return recoverable
  })

export const processRemoteRunnerDeliveries = (
  hostId: string,
  at: Date,
  deliveries: ReadonlyArray<RemoteDelivery>,
  options: RemoteRunnerIterationOptions = {},
) =>
  Effect.gen(function* () {
    const store = yield* RemoteRunnerStore
    const before = yield* store.recoverReceived()
    const outcomes = yield* recordRemoteRunnerDeliveries(hostId, at, deliveries, options)
    const recoverable = yield* executeReceivedAndDrainResults(at)
    const command = recoverable[0]
    if (command !== undefined) {
      return {
        status: before.some((item) => item.commandId === command.commandId)
          ? ("recovered" as const)
          : ("executed" as const),
        commandId: command.commandId,
        consumedRedelivery: deliveries.length > 0,
      }
    }
    const duplicate = outcomes.find((outcome) => outcome.disposition === "duplicate")
    if (duplicate?.commandId !== undefined) {
      return { status: "duplicate" as const, commandId: duplicate.commandId }
    }
    return { status: deliveries.length === 0 ? ("idle" as const) : ("rejected" as const) }
  })

export const runRemoteRunnerIteration = (
  hostId: string,
  at: Date,
  options: RemoteRunnerIterationOptions = {},
) =>
  Effect.gen(function* () {
    const transport = yield* RemoteTransport
    const deliveries = yield* transport.takeHostBatch(hostId)
    return yield* processRemoteRunnerDeliveries(hostId, at, deliveries, options)
  })

export const runRemoteRunnerLoop = (hostId: string, options: RemoteRunnerLoopOptions = {}) =>
  Effect.gen(function* () {
    const transport = yield* RemoteTransport
    const outboxRetryIntervalMs = options.outboxRetryIntervalMs ?? 1_000
    yield* Effect.forever(
      Effect.suspend(() => drainPendingResults(new Date())).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("Remote runner result outbox drain failed", cause),
        ),
        Effect.andThen(Effect.sleep(outboxRetryIntervalMs)),
      ),
    ).pipe(Effect.forkScoped)
    const queue = yield* Queue.unbounded<RemoteDelivery>()
    yield* Effect.forever(
      Effect.gen(function* () {
        const first = yield* Queue.take(queue)
        const batch = [first]
        while (batch.length < 100) {
          const next = yield* Queue.poll(queue)
          if (Option.isNone(next)) break
          batch.push(next.value)
        }
        yield* recordRemoteRunnerDeliveries(hostId, new Date(), batch, {})
        if (batch.at(-1)?.pending === 0) {
          yield* executeReceivedAndDrainResults(new Date(), false)
        }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("Remote runner delivery batch failed", cause),
        ),
      ),
    ).pipe(Effect.forkScoped)
    return yield* Effect.forever(
      transport
        .consumeHost(hostId, (delivery) => Queue.offer(queue, delivery))
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError("Remote runner consumer failed", cause).pipe(
              Effect.andThen(Effect.sleep(1_000)),
            ),
          ),
        ),
    )
  })
