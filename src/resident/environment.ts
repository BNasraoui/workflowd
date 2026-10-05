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
export const workerEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    forwarded.flatMap((key) => {
      const value = process.env[key]
      return value === undefined ? [] : [[key, value]]
    }),
  )
