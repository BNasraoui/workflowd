import { Schema } from "effect"
import { utf8BoundedText } from "./agent-wait-contract"

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

const ROUTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MODEL_PAIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/]\S*$/

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

export const AgentRunSubmission = Schema.Struct({
  route: utf8BoundedText(MAX_AGENT_RUN_ROUTE_BYTES),
  repository: utf8BoundedText(MAX_AGENT_RUN_REPOSITORY_BYTES),
  prompt: utf8BoundedText(MAX_AGENT_RUN_PROMPT_BYTES),
  parentSessionId: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_SESSION_ID_BYTES)),
  /** Which harness holds the parent: an opencode session on the managed
   * server (default), or a Claude Code session woken through the claude
   * CLI. Children are always opencode. */
  parentKind: Schema.optional(Schema.Literals(["opencode", "claude"])),
  /** The Claude parent's working directory — the cwd its session was
   * created in. Required with parentKind "claude"; ignored otherwise. */
  parentDirectory: Schema.optional(utf8BoundedText(4_096)),
  resumePrompt: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_PROMPT_BYTES)),
  idempotencyKey: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_IDEMPOTENCY_KEY_BYTES)),
})
export type AgentRunSubmission = typeof AgentRunSubmission.Type

export const AgentRunReceipt = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  nativeSessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  outputTokens: Schema.Int,
  status: Schema.Literals(["dispatched", "duplicate"]),
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
})
export type AgentRunRefusal = typeof AgentRunRefusal.Type
