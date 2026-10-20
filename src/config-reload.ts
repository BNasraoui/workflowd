import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Context, Schema } from "effect"
import { loadConfig, type AgentRunConfig } from "./config"
import { parseReloadEnvironment } from "./config-env-file"

export type DispatchSettings = Pick<
  AgentRunConfig,
  "repositories" | "routes" | "codexRoutes" | "claudeRoutes"
>
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
  const settings = (runs: AgentRunConfig | undefined): DispatchSettings | undefined =>
    runs === undefined
      ? undefined
      : {
          repositories: runs.repositories,
          routes: runs.routes,
          codexRoutes: runs.codexRoutes,
          claudeRoutes: runs.claudeRoutes,
        }
  let current = settings(config.agentRuns)
  let pending = Promise.resolve()
  let closed = false
  const reload = async () => {
    let stage = "read_failed"
    try {
      const candidateEnvironment = { ...startEnvironment }
      for (const file of files) {
        const content = await readFile(file, "utf8")
        stage = "invalid_environment_file"
        Object.assign(candidateEnvironment, parseReloadEnvironment(content))
        stage = "read_failed"
      }
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
      const restart = Object.keys(candidateEnvironment).filter(
        (name) => !(name in reloadable) && candidateEnvironment[name] !== startEnvironment[name],
      )
      // Include groups for changed file-backed values, even when the path is unchanged.
      const pinned = (runs: AgentRunConfig | undefined) => {
        if (runs === undefined) return undefined
        const { repositories, routes, codexRoutes, claudeRoutes, ...rest } = runs
        return rest
      }
      for (const [group, value] of Object.entries(config)) {
        const requested: unknown = Reflect.get(candidate, group)
        if (group === "agentRuns") {
          if (!same(pinned(config.agentRuns), pinned(candidate.agentRuns))) restart.push(group)
        } else if (!same(value, requested)) restart.push(group)
      }
      current = settings(effective.agentRuns)
      log(
        `Configuration reload: changed=${changed.join(",") || "none"} restart_required=${restart.sort().join(",") || "none"}`,
      )
    } catch {
      // Parser and filesystem errors may contain secret values or paths.
      log(`Configuration reload: error=${stage} changed=none restart_required=none`)
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
