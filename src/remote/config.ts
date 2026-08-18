import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseNatsServers } from "./nats-url"

export type RemoteProcessConfig = {
  readonly servers: ReadonlyArray<string>
  readonly token: string
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
  const direct = env.WORKFLOWD_NATS_TOKEN
  const file = env.WORKFLOWD_NATS_TOKEN_FILE
  if (direct !== undefined && file !== undefined) {
    throw new Error("WORKFLOWD_NATS_TOKEN and WORKFLOWD_NATS_TOKEN_FILE cannot both be set")
  }
  if (direct === undefined && file === undefined) {
    throw new Error("Set exactly one of WORKFLOWD_NATS_TOKEN or WORKFLOWD_NATS_TOKEN_FILE")
  }
  const token =
    direct ??
    (await (options.readFile ?? ((path: string) => readFile(path, "utf8")))(file!)).replace(
      /\r?\n$/,
      "",
    )
  if (token === "") throw new Error("NATS token must not be empty")
  const rawServers = env.WORKFLOWD_NATS_SERVERS
  if (rawServers === undefined) throw new Error("WORKFLOWD_NATS_SERVERS is required")
  const servers = parseNatsServers(rawServers)
  const home = options.home ?? homedir()
  return {
    servers,
    token,
    hostId: hostId(env.WORKFLOWD_REMOTE_HOST_ID),
    databasePath:
      env.WORKFLOWD_REMOTE_DATABASE_PATH ?? join(home, ".local/state/workflowd-runner/runner.db"),
  }
}
