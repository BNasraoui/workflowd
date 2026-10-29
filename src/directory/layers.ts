import { Layer } from "effect"
import type { AppConfig } from "../config"
import { RemoteTransportLive } from "../remote/transport"
import { AgentDirectoryLive } from "./service"
import { DirectoryRemoteLive } from "./remote"

export const makeDirectoryLayer = (config: AppConfig) =>
  config.executionCapabilities === undefined
    ? Layer.empty
    : AgentDirectoryLive(
        config.worker.hostId,
        config.directoryRemote?.leaseMs,
        config.directoryRemote,
      )

export const makeDirectoryRemoteLayer = (config: AppConfig) =>
  config.directoryRemote === undefined
    ? Layer.empty
    : DirectoryRemoteLive(config.worker.hostId, config.directoryRemote).pipe(
        Layer.provide(RemoteTransportLive(config.directoryRemote)),
      )
