import { Schema } from "effect"
import { utf8BoundedText } from "./agent-wait-contract"
import { RequestedSelection, ResolvedSelection } from "./execution-selection"

export const MAX_AGENT_RUN_PROMPT_BYTES = 32_768
export const MAX_AGENT_RUN_ROUTE_BYTES = 128
export const MAX_AGENT_RUN_REPOSITORY_BYTES = 128
export const MAX_AGENT_RUN_IDEMPOTENCY_KEY_BYTES = 128
export const MAX_AGENT_RUN_SESSION_ID_BYTES = 256

/**
 * One dispatchable route: a caller-facing name bound to a concrete
 * provider/model pair on the OpenCode server. Callers never spell the
 * provider-prefixed pair; they name the route (an intent like `implement`)
 * or the bare model id, and the server resolves it.
 */
export type AgentRunRoute = {
  readonly name: string
  readonly providerID: string
  readonly modelID: string
}

export type AgentRunRepository = {
  readonly name: string
  readonly directory: string
}

/**
 * One dispatchable Codex CLI route: a caller-facing name bound to a codex
 * model id. `modelID === null` means the codex CLI's own default model, so a
 * deployment can expose codex without pinning a model.
 */
export type AgentRunCliRoute = {
  readonly name: string
  readonly modelID: string | null
}

export type AgentRunCodexRoute = AgentRunCliRoute

/** A model passed directly to `claude --model` on the daemon host. */
export type AgentRunClaudeRoute = AgentRunCliRoute

const ROUTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MODEL_PAIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/]\S*$/
const CODEX_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Parses `name=provider/model` pairs separated by commas, as configured in
 * WORKFLOWD_AGENT_RUN_ROUTES. Throws on malformed input because it runs at
 * config load, where every other validation failure is also a thrown Error.
 */
export function parseAgentRunRoutes(value: string): ReadonlyArray<AgentRunRoute> {
  const routes = value.split(",").map((entry) => {
    const separator = entry.indexOf("=")
    const name = separator === -1 ? "" : entry.slice(0, separator).trim()
    const pair = separator === -1 ? "" : entry.slice(separator + 1).trim()
    if (!ROUTE_NAME_PATTERN.test(name) || name.length > MAX_AGENT_RUN_ROUTE_BYTES) {
      throw new Error(`WORKFLOWD_AGENT_RUN_ROUTES has an invalid route name in "${entry.trim()}"`)
    }
    if (!MODEL_PAIR_PATTERN.test(pair)) {
      throw new Error(`WORKFLOWD_AGENT_RUN_ROUTES route "${name}" must map to provider/model`)
    }
    const slash = pair.indexOf("/")
    return { name, providerID: pair.slice(0, slash), modelID: pair.slice(slash + 1) }
  })
  const names = new Set(routes.map((route) => route.name))
  if (names.size !== routes.length) {
    throw new Error("WORKFLOWD_AGENT_RUN_ROUTES route names must be unique")
  }
  return routes
}

/**
 * Parses `name=model` pairs separated by commas, as configured in
 * WORKFLOWD_AGENT_RUN_CODEX_ROUTES. The model is a codex model id
 * (e.g. `gpt-5.1-codex`); an empty value after `=` or a bare name maps the
 * route to the codex CLI's default model. Throws on malformed input because
 * it runs at config load, where every other validation failure is also a
 * thrown Error.
 */
export function parseAgentRunCodexRoutes(value: string): ReadonlyArray<AgentRunCodexRoute> {
  return parseCliRoutes(value, "WORKFLOWD_AGENT_RUN_CODEX_ROUTES", "codex")
}

export function parseAgentRunClaudeRoutes(value: string): ReadonlyArray<AgentRunClaudeRoute> {
  return parseCliRoutes(value, "WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES", "claude")
}

function parseCliRoutes(
  value: string,
  setting: string,
  cli: string,
): ReadonlyArray<AgentRunCodexRoute> {
  const routes = value.split(",").map((entry) => {
    const separator = entry.indexOf("=")
    const name = separator === -1 ? entry.trim() : entry.slice(0, separator).trim()
    const model = separator === -1 ? "" : entry.slice(separator + 1).trim()
    if (!ROUTE_NAME_PATTERN.test(name) || name.length > MAX_AGENT_RUN_ROUTE_BYTES) {
      throw new Error(`${setting} has an invalid route name in "${entry.trim()}"`)
    }
    if (
      model !== "" &&
      (!CODEX_MODEL_PATTERN.test(model) || model.length > MAX_AGENT_RUN_ROUTE_BYTES)
    ) {
      throw new Error(
        `${setting} route "${name}" must map to a ${cli} model id ` +
          "or nothing for the CLI default",
      )
    }
    return { name, modelID: model === "" ? null : model }
  })
  const names = new Set(routes.map((route) => route.name))
  if (names.size !== routes.length) {
    throw new Error(`${setting} route names must be unique`)
  }
  return routes
}

/**
 * Parses `name=/absolute/path` pairs separated by commas, as configured in
 * WORKFLOWD_AGENT_RUN_REPOSITORIES. Only repositories named here are
 * dispatchable — this is the allow-list that keeps arbitrary prompt
 * execution off arbitrary directories.
 */
export function parseAgentRunRepositories(value: string): ReadonlyArray<AgentRunRepository> {
  const repositories = value.split(",").map((entry) => {
    const separator = entry.indexOf("=")
    const name = separator === -1 ? "" : entry.slice(0, separator).trim()
    const directory = separator === -1 ? "" : entry.slice(separator + 1).trim()
    if (!ROUTE_NAME_PATTERN.test(name) || name.length > MAX_AGENT_RUN_REPOSITORY_BYTES) {
      throw new Error(
        `WORKFLOWD_AGENT_RUN_REPOSITORIES has an invalid repository name in "${entry.trim()}"`,
      )
    }
    if (!directory.startsWith("/") || directory.endsWith("/") || directory.includes("//")) {
      throw new Error(
        `WORKFLOWD_AGENT_RUN_REPOSITORIES repository "${name}" must map to a normalized absolute path`,
      )
    }
    return { name, directory }
  })
  const names = new Set(repositories.map((repository) => repository.name))
  if (names.size !== repositories.length) {
    throw new Error("WORKFLOWD_AGENT_RUN_REPOSITORIES repository names must be unique")
  }
  return repositories
}

export type AgentRunRouteResolution =
  | { readonly outcome: "resolved"; readonly route: AgentRunRoute }
  | {
      readonly outcome: "refused"
      readonly reason: "provider_prefixed_route" | "unknown_route" | "ambiguous_route"
    }

/**
 * Resolves a caller-supplied route: an exact route name first, then a bare
 * model id when exactly one configured route serves that model. A
 * provider-prefixed id is refused outright so no caller path ever carries
 * provider dialects.
 */
export function resolveAgentRunRoute(
  routes: ReadonlyArray<AgentRunRoute>,
  requested: string,
): AgentRunRouteResolution {
  if (requested.includes("/")) {
    return { outcome: "refused", reason: "provider_prefixed_route" }
  }
  const named = routes.find((route) => route.name === requested)
  if (named !== undefined) return { outcome: "resolved", route: named }
  const byModel = routes.filter((route) => route.modelID === requested)
  if (byModel.length === 1) return { outcome: "resolved", route: byModel[0]! }
  return {
    outcome: "refused",
    reason: byModel.length === 0 ? "unknown_route" : "ambiguous_route",
  }
}

/**
 * Which harness a resolved dispatch runs on: the OpenCode server or a
 * Codex / Claude CLI process on the daemon host.
 */
export type AgentRunRouteProvider = "opencode" | "codex" | "claude"

export type AgentRunRouteChoice =
  | { readonly outcome: "resolved"; readonly provider: "opencode"; readonly route: AgentRunRoute }
  | { readonly outcome: "resolved"; readonly provider: "codex"; readonly route: AgentRunCodexRoute }
  | {
      readonly outcome: "resolved"
      readonly provider: "claude"
      readonly route: AgentRunClaudeRoute
    }
  | {
      readonly outcome: "refused"
      readonly reason: "provider_prefixed_route" | "unknown_route" | "ambiguous_route"
    }

/**
 * Resolves a caller-supplied route across the dispatch harnesses.
 * A name or bare model id served by multiple harnesses is refused `ambiguous_route`; a
 * provider-prefixed id is refused outright so no caller path ever carries
 * provider dialects.
 */
export function resolveAgentRunRouteChoice(
  routes: ReadonlyArray<AgentRunRoute>,
  codexRoutes: ReadonlyArray<AgentRunCodexRoute>,
  requested: string,
  claudeRoutes: ReadonlyArray<AgentRunClaudeRoute> = [],
): AgentRunRouteChoice {
  if (requested.includes("/")) {
    return { outcome: "refused", reason: "provider_prefixed_route" }
  }
  const choices: Array<Extract<AgentRunRouteChoice, { outcome: "resolved" }>> = [
    ...routes.map((route) => ({
      outcome: "resolved" as const,
      provider: "opencode" as const,
      route,
    })),
    ...codexRoutes.map((route) => ({
      outcome: "resolved" as const,
      provider: "codex" as const,
      route,
    })),
    ...claudeRoutes.map((route) => ({
      outcome: "resolved" as const,
      provider: "claude" as const,
      route,
    })),
  ]
  const named = choices.filter(({ route }) => route.name === requested)
  const matches =
    named.length > 0 ? named : choices.filter(({ route }) => route.modelID === requested)
  if (matches.length === 1 && matches[0] !== undefined) return matches[0]
  return { outcome: "refused", reason: matches.length === 0 ? "unknown_route" : "ambiguous_route" }
}

const CLAUDE_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Parses the comma-separated host allow-list from
 * WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS. Entries are plain host ids only —
 * routing is the remote command plane's job, so no destinations or
 * credentials belong here. Throws on malformed input like the other
 * config-load parsers.
 */
export function parseAgentRunClaudeHosts(value: string): ReadonlyArray<string> {
  const hosts = value.split(",").map((entry) => entry.trim())
  for (const host of hosts) {
    if (!CLAUDE_HOST_PATTERN.test(host)) {
      throw new Error(`WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS has an invalid host id "${host}"`)
    }
  }
  if (new Set(hosts).size !== hosts.length) {
    throw new Error("WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS host ids must be unique")
  }
  return hosts
}

export const AgentRunSubmission = Schema.Struct({
  ...RequestedSelection.fields,
  repository: utf8BoundedText(MAX_AGENT_RUN_REPOSITORY_BYTES),
  prompt: utf8BoundedText(MAX_AGENT_RUN_PROMPT_BYTES),
  parentSessionId: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_SESSION_ID_BYTES)),
  /** Which harness holds the parent: an opencode session on the managed
   * server (default), or a Claude Code session woken through the claude
   * CLI. Parent wakes currently require an OpenCode child. */
  parentKind: Schema.optional(Schema.Literals(["opencode", "claude"])),
  /** Host owning the Claude parent session. Defaults to the daemon host;
   * other hosts must be on the server's claude-hosts allow-list, where the
   * wake is delivered by that host's workflowd runner. */
  parentHost: Schema.optional(utf8BoundedText(64)),
  /** The Claude parent's working directory — the cwd its session was
   * created in. Required with parentKind "claude"; ignored otherwise. */
  parentDirectory: Schema.optional(utf8BoundedText(4_096)),
  resumePrompt: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_PROMPT_BYTES)),
  idempotencyKey: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_IDEMPOTENCY_KEY_BYTES)),
})
export type AgentRunSubmission = typeof AgentRunSubmission.Type

export const AgentRunReceipt = Schema.Struct({
  runId: Schema.String,
  mailboxId: Schema.String,
  sessionId: Schema.String,
  nativeSessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  outputTokens: Schema.Int,
  status: Schema.Literals(["dispatched", "duplicate"]),
  requestedSelection: Schema.optionalKey(RequestedSelection),
  resolvedSelection: Schema.optionalKey(ResolvedSelection),
  wait: Schema.optional(
    Schema.Struct({
      waitId: Schema.String,
      instanceId: Schema.String,
      status: Schema.Literals(["registered", "duplicate"]),
    }),
  ),
})
export type AgentRunReceipt = typeof AgentRunReceipt.Type

export const AgentRunRefusal = Schema.Struct({
  error: Schema.String,
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  mailboxId: Schema.optional(Schema.String),
})
export type AgentRunRefusal = typeof AgentRunRefusal.Type
