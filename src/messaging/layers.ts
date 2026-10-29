import { Layer } from "effect"
import type { AppConfig } from "../config"
import { RemoteTransportLive } from "../remote/transport"
import { AgentMessagingLive } from "./service"
import { MessageDeliveryLive } from "./delivery"
import { MessageRemoteLive } from "./remote"

export const makeMessagingLayer = (config: AppConfig) =>
  !config.messagingEnabled
    ? Layer.empty
    : Layer.mergeAll(
        AgentMessagingLive(config.worker.hostId),
        MessageDeliveryLive(config.worker.hostId),
        config.directoryRemote === undefined
          ? Layer.empty
          : MessageRemoteLive(config.worker.hostId, config.directoryRemote.peers).pipe(
              Layer.provide(RemoteTransportLive(config.directoryRemote)),
            ),
      )
