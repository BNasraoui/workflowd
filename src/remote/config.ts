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
  /** Absolute directory prefixes this runner opts in for claude_resume
   * execution; empty (unset) refuses every claude wake. */
  readonly claudeDirectories: ReadonlyArray<string>
  readonly claudeBinary: string
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
  const claudeDirectories = (env.WORKFLOWD_RUNNER_CLAUDE_DIRS ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  for (const directory of claudeDirectories) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(directory) || directory.endsWith("/")) {
      throw new Error(
        "WORKFLOWD_RUNNER_CLAUDE_DIRS entries must be plain absolute paths without a trailing slash",
      )
    }
  }
  return {
    servers,
    auth,
    hostId: hostId(env.WORKFLOWD_REMOTE_HOST_ID),
    databasePath:
      env.WORKFLOWD_REMOTE_DATABASE_PATH ?? join(home, ".local/state/workflowd-runner/runner.db"),
    claudeDirectories,
    claudeBinary: env.WORKFLOWD_AGENT_RUN_CLAUDE_BIN ?? "claude",
  }
}
