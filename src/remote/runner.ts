import { Effect, Queue } from "effect"
import { decodeRemoteHostMessage } from "./codec"
import { RemoteRunnerStore, type RemoteRunnerStorePort } from "./runner-store"
import { RemoteTransport } from "./transport"
import type { RemoteDelivery } from "./transport"

export type RemoteRunnerIterationOptions = {
  readonly afterDurableReceipt?: () => Effect.Effect<void, Error, RemoteRunnerStorePort>
}

export const processRemoteRunnerDeliveries = (
  hostId: string,
  at: Date,
  deliveries: ReadonlyArray<RemoteDelivery>,
  options: RemoteRunnerIterationOptions = {},
) =>
  Effect.gen(function* () {
    const store = yield* RemoteRunnerStore
    const transport = yield* RemoteTransport
    const before = yield* store.recoverReceived()
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
    const recoverable = yield* store.recoverReceived()
    for (const command of recoverable) yield* store.executeProbe(command, at)
    const results = yield* store.pendingResults()
    for (const result of results) {
      yield* transport.publishResult(result)
      yield* store.markResultPublished(result.resultId, at)
    }
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

export const runRemoteRunnerLoop = (hostId: string) =>
  Effect.gen(function* () {
    const transport = yield* RemoteTransport
    yield* processRemoteRunnerDeliveries(hostId, new Date(), [])
    const queue = yield* Queue.unbounded<RemoteDelivery>()
    yield* Effect.forever(
      Effect.gen(function* () {
        const first = yield* Queue.take(queue)
        const batch = [first]
        for (let index = 0; index < first.pending; index += 1) {
          batch.push(yield* Queue.take(queue))
        }
        yield* processRemoteRunnerDeliveries(hostId, new Date(), batch)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("Remote runner delivery batch failed", cause),
        ),
      ),
    ).pipe(Effect.forkScoped)
    return yield* transport.consumeHost(hostId, (delivery) => Queue.offer(queue, delivery))
  })
