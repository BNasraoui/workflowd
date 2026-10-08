import { Effect, Layer, Option, Schedule } from "effect"
import { RemoteTransport } from "../remote/transport"
import { DirectoryRemoteStore } from "./remote-store"
import type { DirectoryRemoteConfig } from "./config"
import {
  DirectoryPage,
  authenticDirectoryMessage,
  decodeDirectoryMessage,
  directoryBytes,
} from "./wire"

export const DirectoryRemoteLive = (hostId: string, config: DirectoryRemoteConfig) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const transportOption = yield* Effect.serviceOption(RemoteTransport)
      if (Option.isNone(transportOption))
        return yield* Effect.die(new Error("Directory command transport is required"))
      const transport = transportOption.value
      const store = yield* DirectoryRemoteStore
      const receive = transport.takeDirectoryReplies
      if (receive === undefined)
        return yield* Effect.die(new Error("Directory requires the current command transport"))
      const request = Effect.fn("DirectoryRemote.request")(function* () {
        yield* transport.ensureInfrastructure()
        for (const peer of config.peers) {
          const command = yield* store.prepare(
            peer,
            hostId,
            new Date(),
            config.refreshMs,
            config.leaseMs,
          )
          if (command !== null)
            yield* transport.publishRaw(
              `workflowd.v1.commands.${peer.hostId}`,
              directoryBytes(command),
            )
        }
      })
      yield* request().pipe(
        Effect.catch((error) => Effect.logError("Directory observation request failed", error)),
        Effect.repeat(Schedule.spaced(config.refreshMs)),
        Effect.forkScoped,
      )
      const observe = Effect.fn("DirectoryRemote.observe")(function* () {
        const deliveries = yield* receive(hostId, 1_000)
        for (const delivery of deliveries) {
          const result = yield* decodeDirectoryMessage(DirectoryPage, delivery.data).pipe(
            Effect.result,
          )
          if (result._tag === "Success") {
            const page = result.success
            const peer = config.peers.find((peer) => peer.hostId === page.hostId)
            if (
              peer !== undefined &&
              page.coordinatorHostId === hostId &&
              authenticDirectoryMessage(peer.credential, page)
            )
              yield* store
                .accept(page, new Date(), config.leaseMs)
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Directory observation refused", error.reason),
                  ),
                )
          }
          yield* delivery.acknowledge
        }
      })
      yield* observe().pipe(
        Effect.catch((error) => Effect.logError("Directory observation transport failed", error)),
        Effect.repeat(Schedule.spaced("10 millis")),
        Effect.forkScoped,
      )
    }),
  )
