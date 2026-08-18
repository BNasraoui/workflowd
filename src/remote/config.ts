import { homedir } from "node:os"
import { join } from "node:path"
import { loadRemoteNatsAuth } from "./auth"
import type { RemoteNatsAuth } from "./auth"
import { parseNatsServers } from "./nats-url"

export type RemoteProcessConfig = {
  readonly servers: ReadonlyArray<string>
  readonly auth: RemoteNatsAuth
  readonly hostId: string
  readonly databasePath: string
}

export type RemoteConfigOptions = {
  readonly readFile?: (path: string) => Promise<string>
  readonly home?: string
}

const hostId = (value: string | undefined) => {
  if (value === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/.test(value)) {
    throw new Error("WORKFLOWD_REMOTE_HOST_ID must be a valid host ID")
  }
  return value
}

export async function loadRemoteProcessConfig(
  env: Record<string, string | undefined>,
  options: RemoteConfigOptions = {},
): Promise<RemoteProcessConfig> {
  const auth = await loadRemoteNatsAuth(env, options.readFile)
  const rawServers = env.WORKFLOWD_NATS_SERVERS
  if (rawServers === undefined) throw new Error("WORKFLOWD_NATS_SERVERS is required")
  const servers = parseNatsServers(rawServers)
  const home = options.home ?? homedir()
  return {
    servers,
    auth,
    hostId: hostId(env.WORKFLOWD_REMOTE_HOST_ID),
    databasePath:
      env.WORKFLOWD_REMOTE_DATABASE_PATH ?? join(home, ".local/state/workflowd-runner/runner.db"),
  }
}
