import { Effect, Layer, Schedule } from "effect"
import { AgentRunProvider } from "../kernel/agent-run-ingress"
import { DirectoryStore } from "./store"

type ObservationOptions = {
  readonly endpointIdentity: string
  readonly leaseMs: number
  readonly now: () => Date
}

// This pass only reads native bindings. Parked waits never enter stall/completion supervision.
export const runManagedDirectoryObservation = Effect.fn("Directory.observeManagedBindings")(
  function* (options: ObservationOptions) {
    const store = yield* DirectoryStore
    const provider = yield* AgentRunProvider
    const bindings = yield* store.openCodeBindings(options.endpointIdentity)
    yield* Effect.forEach(
      bindings,
      (binding) =>
        Effect.gen(function* () {
          const observed = yield* provider
            .sessionTelemetry({ sessionID: binding.nativeSessionId })
            .pipe(Effect.timeout("2 seconds"), Effect.result)
          if (
            observed._tag === "Success" &&
            observed.success?.sessionID === binding.nativeSessionId &&
            observed.success.directory === binding.directory
          )
            yield* store.observeManaged(
              binding.runId,
              {
                nativeSessionId: observed.success.sessionID,
                directory: observed.success.directory,
              },
              options.now(),
              options.leaseMs,
            )
          else yield* store.unavailableManaged(binding.runId, binding.nativeSessionId)
        }),
      { concurrency: 8, discard: true },
    )
  },
)

export const ManagedDirectoryObservationsLive = (
  options: ObservationOptions & { readonly hostId: string; readonly refreshMs: number },
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* DirectoryStore
      yield* store.bindLocalHost(options.hostId)
      yield* runManagedDirectoryObservation(options).pipe(
        Effect.catch((error) => Effect.logWarning("Managed directory observation failed", error)),
        Effect.repeat(Schedule.spaced(options.refreshMs)),
        Effect.forkScoped,
      )
    }),
  )
