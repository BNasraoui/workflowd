import { Effect } from "effect"
import type {
  AgentRunIngressOptions,
  AgentRunProviderPort,
  AgentRunRefusalError,
} from "./agent-run-ingress"
import type { AgentWaitIngressPort } from "./agent-wait-ingress"
import {
  CLAUDE_ENDPOINT_ALIAS,
  CLAUDE_PROVIDER_ID,
  claudeEndpointIdentity,
  claudeSessionCustodyId,
  type ClaudeCliPort,
} from "./claude-session"
import {
  CODEX_ENDPOINT_ALIAS,
  CODEX_PROVIDER_ID,
  codexEndpointIdentity,
  codexSessionCustodyId,
} from "./codex-session"
import type { KernelSessionStorePort } from "./session-store"

type CustodyRefusalReason = "invalid_wait_pairing" | "missing_parent_session"

export const makeAgentRunCustody = (dependencies: {
  readonly sessions: KernelSessionStorePort
  readonly provider: AgentRunProviderPort | undefined
  readonly waits: AgentWaitIngressPort | undefined
  readonly claude: ClaudeCliPort | undefined
  readonly options: Pick<AgentRunIngressOptions, "identity" | "claudeHosts">
  readonly refuse: (reason: CustodyRefusalReason, detail: string) => AgentRunRefusalError
}) => {
  const { sessions, provider, waits, claude, options, refuse } = dependencies

  const ensureResource = (input: {
    readonly resourceId: string
    readonly absolutePath: string
    readonly kind: "workspace" | "worktree" | "checkout"
    readonly createdAt: Date
  }) =>
    Effect.gen(function* () {
      const held = yield* sessions.readResourceByPath({
        owningHostId: options.identity.owningHostId,
        absolutePath: input.absolutePath,
      })
      if (held !== null && typeof held.resource_id === "string") return held.resource_id
      yield* sessions.registerResource({
        resourceId: input.resourceId,
        owningHostId: options.identity.owningHostId,
        absolutePath: input.absolutePath,
        kind: input.kind,
        createdAt: input.createdAt,
      })
      return input.resourceId
    })

  const ensureSession = (input: {
    readonly nativeSessionId: string
    readonly resourceId: string
    readonly createdAt: Date
    readonly kind?: "opencode" | "claude" | "codex"
    readonly host?: string
    readonly sandboxEndpoint?: string
  }) =>
    Effect.gen(function* () {
      const kind = input.kind ?? "opencode"
      const claudeHost = input.host ?? options.identity.owningHostId
      const providerConfig = {
        claude: {
          sessionId: claudeSessionCustodyId(input.nativeSessionId),
          providerId: CLAUDE_PROVIDER_ID,
          serverId: claudeHost,
          endpointAlias: CLAUDE_ENDPOINT_ALIAS,
          endpointIdentity: claudeEndpointIdentity(claudeHost),
        },
        codex: {
          sessionId: codexSessionCustodyId(input.nativeSessionId),
          providerId: CODEX_PROVIDER_ID,
          serverId: options.identity.serverId,
          endpointAlias: CODEX_ENDPOINT_ALIAS,
          endpointIdentity: codexEndpointIdentity(options.identity.owningHostId),
        },
        opencode: {
          sessionId: `opencode-session-${input.nativeSessionId}`,
          providerId: options.identity.providerId,
          serverId:
            input.sandboxEndpoint === undefined
              ? options.identity.serverId
              : `sandbox:${input.nativeSessionId}`,
          endpointAlias:
            input.sandboxEndpoint === undefined ? options.identity.endpointAlias : "sandbox",
          endpointIdentity: input.sandboxEndpoint ?? options.identity.endpointIdentity,
        },
      }[kind]
      const { sessionId } = providerConfig
      if ((yield* sessions.readSession(sessionId)) === null) {
        yield* sessions.registerSession({
          providerKind: kind,
          providerVersion: options.identity.providerVersion,
          ...providerConfig,
          owningHostId: options.identity.owningHostId,
          nativeSessionId: input.nativeSessionId,
          resourceId: input.resourceId,
          createdAt: input.createdAt,
        })
      }
      return sessionId
    })

  const resolveParentDirectory = (parent: {
    readonly nativeSessionId: string
    readonly kind: "opencode" | "claude"
    readonly host: string
    readonly directory: string | undefined
  }) =>
    Effect.gen(function* () {
      if (parent.kind === "claude") {
        if (parent.directory === undefined) {
          return yield* refuse(
            "invalid_wait_pairing",
            "parentDirectory is required when parentKind is claude",
          )
        }
        const known = [options.identity.owningHostId, ...options.claudeHosts]
        if (!known.includes(parent.host)) {
          return yield* refuse(
            "missing_parent_session",
            `host ${parent.host} is not on the claude-hosts allow-list; its sessions cannot be woken`,
          )
        }
        if (parent.host !== options.identity.owningHostId) return parent.directory
        if (claude === undefined)
          return yield* refuse("missing_parent_session", "Claude parent executor is disabled")
        const exists = yield* claude.sessionExists({
          nativeSessionId: parent.nativeSessionId,
          directory: parent.directory,
        })
        if (!exists) {
          return yield* refuse(
            "missing_parent_session",
            `claude session ${parent.nativeSessionId} has no transcript for directory ${parent.directory} on this host`,
          )
        }
        return parent.directory
      }
      if (provider === undefined)
        return yield* refuse("missing_parent_session", "OpenCode executor is disabled")
      const telemetry = yield* provider.sessionTelemetry({ sessionID: parent.nativeSessionId })
      if (telemetry === undefined) {
        return yield* refuse(
          "missing_parent_session",
          `parent session ${parent.nativeSessionId} does not exist on the OpenCode server`,
        )
      }
      return telemetry.directory
    })

  const registerWait = (run: {
    readonly runId: string
    readonly parentNativeSessionId: string
    readonly parentKind: "opencode" | "claude"
    readonly parentHost: string
    readonly parentDirectory: string
    readonly childSessionId: string
    readonly resumePrompt: string
    readonly createdAt: Date
    readonly now: Date
  }) =>
    Effect.gen(function* () {
      if (waits === undefined)
        return yield* refuse("invalid_wait_pairing", "Parent wakes are disabled")
      const parentResourceId = yield* ensureResource({
        resourceId: `${run.parentKind}-session-resource-${run.parentNativeSessionId}`,
        absolutePath: run.parentDirectory,
        kind: "checkout",
        createdAt: run.createdAt,
      })
      const parentSessionId = yield* ensureSession({
        nativeSessionId: run.parentNativeSessionId,
        resourceId: parentResourceId,
        createdAt: run.createdAt,
        kind: run.parentKind,
        host: run.parentHost,
      })
      const receipt = yield* waits.register(
        {
          parentSessionId,
          childSessionId: run.childSessionId,
          resumePrompt: run.resumePrompt,
          idempotencyKey: `${run.runId}-wait`,
        },
        run.createdAt,
      )
      return { waitId: receipt.waitId, instanceId: receipt.instanceId, status: receipt.status }
    })

  return { ensureResource, ensureSession, registerWait, resolveParentDirectory }
}
