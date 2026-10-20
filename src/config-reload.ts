import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Context, Schema } from "effect"
import { loadConfig, type AgentRunConfig } from "./config"
import { parseReloadEnvironment } from "./config-env-file"

export type DispatchSettings = Pick<AgentRunConfig, (typeof reloadable)[keyof typeof reloadable]>
export const AgentRunDispatchSettings = Context.Service<{
  readonly current: () => DispatchSettings | undefined
}>("workflowd/AgentRunDispatchSettings")

const reloadable = {
  WORKFLOWD_AGENT_RUN_REPOSITORIES: "repositories",
  WORKFLOWD_AGENT_RUN_ROUTES: "routes",
  WORKFLOWD_AGENT_RUN_CODEX_ROUTES: "codexRoutes",
  WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES: "claudeRoutes",
} as const
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export async function startConfigReload(
  environment: Record<string, string | undefined>,
  log: (line: string) => void,
) {
  const startEnvironment = { ...environment }
  const config = await loadConfig(startEnvironment)
  const files = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
    JSON.parse(startEnvironment.WORKFLOWD_CONFIG_RELOAD_FILES ?? "[]"),
  )
  if (files.some((path) => !isAbsolute(path)))
    throw new Error("WORKFLOWD_CONFIG_RELOAD_FILES must contain absolute paths")
  // Names supplied by reload files have no inherited startup fallback.
  const baseEnvironment = { ...startEnvironment }
  const startupContents = await Promise.all(files.map((file) => readFile(file, "utf8")))
  for (const content of startupContents)
    for (const name of Object.keys(parseReloadEnvironment(content))) delete baseEnvironment[name]
  const keys = new Set<string>(Object.values(reloadable))
  const settings = (runs: AgentRunConfig | undefined): DispatchSettings | undefined =>
    runs === undefined
      ? undefined
      : (Object.fromEntries(
          Object.values(reloadable).map((key) => [key, runs[key]]),
        ) as DispatchSettings)
  const pinned = (runs: AgentRunConfig | undefined) =>
    runs === undefined
      ? undefined
      : Object.fromEntries(Object.entries(runs).filter(([key]) => !keys.has(key)))
  let current = settings(config.agentRuns)
  let pending = Promise.resolve()
  let closed = false
  const reload = async () => {
    let stage = "read_failed"
    try {
      let candidateEnvironment = { ...baseEnvironment }
      const contents = await Promise.all(files.map((file) => readFile(file, "utf8")))
      stage = "invalid_environment_file"
      for (const content of contents)
        candidateEnvironment = { ...candidateEnvironment, ...parseReloadEnvironment(content) }
      stage = "invalid_configuration"
      const candidate = await loadConfig(candidateEnvironment)
      // Validate against pinned infrastructure as well as the requested full config.
      const effectiveEnvironment = { ...startEnvironment }
      for (const name of Object.keys(reloadable))
        effectiveEnvironment[name] = candidateEnvironment[name]
      const effective = await loadConfig(effectiveEnvironment)
      const changed = Object.entries(reloadable)
        .filter(([, key]) => !same(current?.[key], effective.agentRuns?.[key]))
        .map(([name]) => name)
      const restart = [
        ...new Set([...Object.keys(startEnvironment), ...Object.keys(candidateEnvironment)]),
      ]
        .filter(
          (name) =>
            !Object.hasOwn(reloadable, name) &&
            candidateEnvironment[name] !== startEnvironment[name],
        )
        .sort()
      // Include groups for changed file-backed values, even when the path is unchanged.
      const groups: string[] = []
      for (const [group, value] of Object.entries(config)) {
        const requested: unknown = Reflect.get(candidate, group)
        if (group === "agentRuns") {
          if (!same(pinned(config.agentRuns), pinned(candidate.agentRuns))) groups.push(group)
        } else if (!same(value, requested)) groups.push(group)
      }
      const next = settings(effective.agentRuns)
      const line = `Configuration reload: changed=${changed.join(",") || "none"} restart_required=${restart.join(",") || "none"} restart_required_groups=${groups.sort().join(",") || "none"}`
      log(line)
      current = next
    } catch (cause) {
      // Only a setting name is safe to extract from errors that may contain secrets.
      const setting =
        cause instanceof Error ? /\bWORKFLOWD_[A-Z0-9_]+\b/.exec(cause.message)?.[0] : undefined
      log(
        `Configuration reload: error=${stage}${setting === undefined ? "" : ` setting=${setting}`} changed=none restart_required=none restart_required_groups=none`,
      )
    }
  }
  const signal = () => {
    if (!closed) pending = pending.then(reload)
  }
  process.on("SIGHUP", signal)
  return {
    config,
    dispatchSettings: { current: () => current },
    settled: () => pending,
    close: async () => {
      closed = true
      process.off("SIGHUP", signal)
      await pending
    },
  }
}
