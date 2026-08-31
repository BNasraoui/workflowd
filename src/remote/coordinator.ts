import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { decodeRemoteResult } from "./codec"
import {
  RemoteCoordinatorStore,
  type RemoteCoordinatorError,
  type RemoteCoordinatorStorePort,
} from "./coordinator-store"
import { RemoteTransport, type RemoteTransportError, type RemoteTransportPort } from "./transport"

export type RemoteDispatchIterationOptions = {
  readonly commandId: () => string
  readonly workerId: string
  readonly now: () => Date
  readonly leaseDurationMs: number
  readonly commandTtlMs: number
  /** TTL for claude_resume commands, which span two CLI inference turns;
   * defaults to commandTtlMs when absent. */
  readonly claudeCommandTtlMs?: number
  readonly afterBrokerPublish?: (
    dispatch: import("./coordinator-store").RemoteDispatch,
  ) => Effect.Effect<
    void,
    RemoteCoordinatorError | RemoteTransportError,
    RemoteCoordinatorStorePort | RemoteTransportPort
  >
}

export const runRemoteDispatchIteration = (options: RemoteDispatchIterationOptions) =>
  Effect.gen(function* () {
    const store = yield* RemoteCoordinatorStore
    const transport = yield* RemoteTransport
    const preparedAt = options.now()
    yield* runRemoteReconciliationIteration(preparedAt)
    const dispatch = yield* store.prepareNext({
      commandId: options.commandId(),
      workerId: options.workerId,
      now: preparedAt,
      leaseDurationMs: options.leaseDurationMs,
      ttlMsForKind: (kind) =>
        kind === "claude_resume"
          ? (options.claudeCommandTtlMs ?? options.commandTtlMs)
          : options.commandTtlMs,
    })
    const pending = yield* store.pendingDispatches()
    for (const item of pending) {
      yield* store.markPublishing(item.commandId, options.now())
      yield* transport.publishFence({
        version: 1,
        kind: "fence",
        jobId: item.jobId,
        generation: item.generation,
        hostId: item.hostId,
        disposition: "current",
        issuedAt: item.issuedAt.toISOString(),
      })
      const base = {
        version: 1 as const,
        commandId: item.commandId,
        jobId: item.jobId,
        attempt: item.attempt,
        generation: item.generation,
        hostId: item.hostId,
        issuedAt: item.issuedAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
      }
      yield* transport.publishCommand(
        item.kind === "claude_resume" && item.payload !== undefined
          ? { ...base, kind: "claude_resume", payload: item.payload }
          : { ...base, kind: "probe" },
      )
      if (options.afterBrokerPublish !== undefined) {
        yield* options.afterBrokerPublish(item)
      }
      yield* store.markPublished(item.commandId, options.now())
    }
    return { dispatch, published: pending.length }
  })

export const runRemoteReconciliationIteration = (at: Date) =>
  Effect.gen(function* () {
    const store = yield* RemoteCoordinatorStore
    const transport = yield* RemoteTransport
    const actions = yield* store.reconcileExpired(at)
    const pendingFences = yield* store.pendingCancellationFences()
    for (const pending of pendingFences) {
      yield* transport.publishFence(pending.fence)
      yield* store.markCancellationFencePublished(pending.commandId, at)
    }
    return {
      retried: actions.filter((action) => action.outcome === "retry_scheduled").length,
      terminal: actions.filter((action) => action.outcome === "failed").length,
    }
  })

export const runRemoteResultIteration = (at: Date) =>
  Effect.gen(function* () {
    const store = yield* RemoteCoordinatorStore
    const transport = yield* RemoteTransport
    const deliveries = yield* transport.takeResults()
    const dispositions = yield* Effect.forEach(deliveries, (delivery) =>
      decodeRemoteResult(delivery.data).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            store.recordRejectedDelivery({
              deliveryId: delivery.deliveryId,
              disposition: error.reason,
              payloadSha256: createHash("sha256").update(delivery.data).digest("hex"),
              payloadBytes: delivery.data.byteLength,
              receivedAt: at,
            }),
          onSuccess: (result) => store.acceptDelivery(delivery.deliveryId, result, at),
        }),
        Effect.tap(() => delivery.acknowledge),
      ),
    )
    return {
      status: deliveries.length === 0 ? ("idle" as const) : ("processed" as const),
      dispositions,
    }
  })

export type RemoteCoordinatorPort = {
  readonly ensure: Effect.Effect<void, RemoteTransportError>
  readonly dispatchIteration: Effect.Effect<
    "idle" | "published",
    RemoteCoordinatorError | RemoteTransportError
  >
  readonly resultIteration: Effect.Effect<
    "idle" | "processed",
    RemoteCoordinatorError | RemoteTransportError
  >
}

export const RemoteCoordinator = Context.Reference("workflowd/remote/RemoteCoordinator", {
  defaultValue: (): RemoteCoordinatorPort | null => null,
})

export const RemoteCoordinatorLive = (config: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly commandTtlMs: number
  readonly claudeCommandTtlMs?: number
}) =>
  Layer.effect(
    RemoteCoordinator,
    Effect.gen(function* () {
      const store = yield* RemoteCoordinatorStore
      const transport = yield* RemoteTransport
      const provide = <A, E>(
        effect: Effect.Effect<A, E, RemoteCoordinatorStorePort | RemoteTransportPort>,
      ) =>
        effect.pipe(
          Effect.provideService(RemoteCoordinatorStore, store),
          Effect.provideService(RemoteTransport, transport),
        )
      return RemoteCoordinator.of({
        ensure: transport.ensureInfrastructure(),
        dispatchIteration: provide(
          runRemoteDispatchIteration({
            commandId: () => crypto.randomUUID(),
            workerId: config.workerId,
            now: () => new Date(),
            leaseDurationMs: config.leaseDurationMs,
            commandTtlMs: config.commandTtlMs,
            ...(config.claudeCommandTtlMs === undefined
              ? {}
              : { claudeCommandTtlMs: config.claudeCommandTtlMs }),
          }),
        ).pipe(Effect.map((result) => (result.published > 0 ? "published" : "idle"))),
        resultIteration: Effect.suspend(() => provide(runRemoteResultIteration(new Date()))).pipe(
          Effect.map((result) => result.status),
        ),
      })
    }),
  )
