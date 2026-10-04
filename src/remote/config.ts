import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { readFile } from "node:fs/promises"
import { loadRemoteNatsAuth } from "./auth"
import type { RemoteNatsAuth } from "./auth"
import { parseNatsServers } from "./nats-url"
import { parseAgentRunRepositories, type AgentRunRepository } from "../agent-run-contract"

export type RemoteProcessConfig = {
  readonly servers: ReadonlyArray<string>
  readonly auth: RemoteNatsAuth
  readonly hostId: string
  readonly databasePath: string
  /** Absolute directory prefixes this runner opts in for claude_resume
   * execution; empty (unset) refuses every claude wake. */
  readonly claudeDirectories: ReadonlyArray<string>
  readonly claudeBinary: string
  readonly agentExecution?: {
    readonly repositories: ReadonlyArray<AgentRunRepository>
    readonly worktreeRoot: string
    readonly codexBinary: string
    readonly openCodeUrl?: string
    readonly openCodePassword: string
    readonly verifyTimeoutMs: number
    readonly progressWindowMs: number
  }
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
  const worktreeRoot =
    env.WORKFLOWD_RUNNER_AGENT_WORKTREE_ROOT ??
    join(home, ".local/state/workflowd-runner/worktrees")
  if (!isAbsolute(worktreeRoot))
    throw new Error("WORKFLOWD_RUNNER_AGENT_WORKTREE_ROOT must be an absolute path")
  const openCodeUrl = env.WORKFLOWD_RUNNER_OPENCODE_URL
  if (openCodeUrl !== undefined) {
    const url = new URL(openCodeUrl)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new Error("WORKFLOWD_RUNNER_OPENCODE_URL must be credential-free HTTP(S)")
  }
  let openCodePassword = env.WORKFLOWD_OPENCODE_PASSWORD ?? ""
  const passwordFile = env.WORKFLOWD_OPENCODE_PASSWORD_FILE
  if (passwordFile !== undefined && passwordFile !== "") {
    if (openCodePassword !== "")
      throw new Error(
        "Set only one of WORKFLOWD_OPENCODE_PASSWORD or WORKFLOWD_OPENCODE_PASSWORD_FILE",
      )
    openCodePassword = await (options.readFile ?? ((path: string) => readFile(path, "utf8")))(
      passwordFile,
    ).then((value) => value.replace(/\r?\n$/, ""))
    if (openCodePassword === "")
      throw new Error("WORKFLOWD_OPENCODE_PASSWORD_FILE must not be empty")
  }
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
    ...(env.WORKFLOWD_RUNNER_AGENT_REPOSITORIES === undefined
      ? {}
      : {
          agentExecution: {
            repositories: parseAgentRunRepositories(env.WORKFLOWD_RUNNER_AGENT_REPOSITORIES),
            worktreeRoot,
            codexBinary: env.WORKFLOWD_AGENT_RUN_CODEX_BIN ?? "codex",
            ...(openCodeUrl === undefined ? {} : { openCodeUrl }),
            openCodePassword,
            verifyTimeoutMs: 120_000,
            progressWindowMs: 20 * 60_000,
          },
        }),
  }
}
