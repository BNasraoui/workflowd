import { Context, Effect, Layer, Option } from "effect"
import { ExecutionDiscovery } from "../execution-capabilities"
import {
  DirectoryError,
  type DirectorySnapshot,
  type ExternalRegistration,
  type RegistrationReceipt,
  runnerIdForHost,
} from "./contract"
import { DirectoryStore } from "./store"
import { verifyExternalEndpoint, verifyRegistration } from "./proof"
import type { DirectoryRemoteConfig } from "./config"
import { DirectoryRemoteStore } from "./remote-store"

export const AgentDirectory = Context.Service<{
  readonly inventory: () => Effect.Effect<DirectorySnapshot, DirectoryError>
  readonly register: (
    input: ExternalRegistration,
  ) => Effect.Effect<RegistrationReceipt, DirectoryError>
}>("workflowd/AgentDirectory")

export const AgentDirectoryLive = (
  hostId: string,
  leaseMs = 90_000,
  remote?: DirectoryRemoteConfig,
) =>
  Layer.effect(
    AgentDirectory,
    Effect.gen(function* () {
      const store = yield* DirectoryStore
      const remoteStore = yield* DirectoryRemoteStore
      const discovery = yield* Effect.serviceOption(ExecutionDiscovery)
      yield* store.bindLocalHost(hostId)
      return AgentDirectory.of({
        register: Effect.fn("AgentDirectory.register")(function* (input) {
          yield* verifyRegistration(input, hostId)
          yield* verifyExternalEndpoint(input).pipe(
            Effect.tapError(() => store.externalUnavailable(input)),
          )
          return yield* store.registerExternal(input, new Date(), leaseMs)
        }),
        inventory: Effect.fn("AgentDirectory.inventory")(function* () {
          const catalog = Option.isNone(discovery)
            ? { capabilities: [], sources: [] }
            : yield* discovery.value
                .list()
                .pipe(Effect.mapError(() => new DirectoryError({ reason: "unavailable" })))
          const now = new Date()
          const observed =
            remote === undefined
              ? { agents: [], runners: [] }
              : yield* remoteStore.inventory(
                  remote.peers.map((peer) => peer.hostId),
                  now,
                )
          return {
            agents: [
              ...(yield* store.managed(now, leaseMs)),
              ...(yield* store.external(now)),
              ...observed.agents,
            ],
            runners: [
              {
                runnerId: runnerIdForHost(hostId),
                hostId,
                status: "active" as const,
                observedAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
                catalog,
              },
              ...observed.runners,
            ],
          }
        }),
      })
    }),
  )
