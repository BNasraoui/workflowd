const forwarded = [
  "HOME",
  "PATH",
  "CLAUDE_CONFIG_DIR",
  "SSH_AUTH_SOCK",
  "GIT_CONFIG_GLOBAL",
  "GIT_SSH_COMMAND",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const

/** Forward worker shell settings without inheriting daemon credentials. */
export const workerEnvironment = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string> => {
  const home = env.WORKFLOWD_AGENT_HOME
  if (env.WORKFLOWD_AGENT_HOST_SOCKET && !home)
    throw new Error("Agent host requires WORKFLOWD_AGENT_HOME")
  if (home) {
    if (!home.startsWith("/")) throw new Error("WORKFLOWD_AGENT_HOME must be absolute")
    return {
      HOME: home,
      PATH: env.WORKFLOWD_AGENT_PATH ?? "/usr/local/bin:/usr/bin:/bin",
      CODEX_HOME: `${home}/.codex`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_STATE_HOME: `${home}/.local/state`,
      XDG_CACHE_HOME: `${home}/.cache`,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    }
  }
  return Object.fromEntries(
    forwarded.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  )
}
