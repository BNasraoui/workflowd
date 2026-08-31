import { createHash } from "node:crypto"
import { join } from "node:path"
import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  AgentRunSubmission,
  resolveAgentRunRoute,
  type AgentRunReceipt,
  type AgentRunRepository,
  type AgentRunRoute,
  type AgentRunSubmission as AgentRunSubmissionType,
} from "../agent-run-contract"
import type { OpenCodeAdapter, OpenCodeAdapterError } from "../opencode/adapter"
import { runWorkspaceCommand } from "../workspace/command"
import type { WorkspaceError } from "../workspace/errors"
import { pathExists } from "../workspace/filesystem"
import { WorkSignal } from "../work-signal"
import { AgentWaitIngress, type AgentWaitIngressError } from "./agent-wait-ingress"
import {
  CLAUDE_ENDPOINT_ALIAS,
  CLAUDE_PROVIDER_ID,
  ClaudeCli,
  claudeEndpointIdentity,
  claudeSessionCustodyId,
} from "./claude-session"
import type { AgentCompletionSourceIdentity } from "./agent-handoff-store"
import { AgentRunStore, type AgentRunRecord, type AgentRunStoreError } from "./agent-run-store"
import { KernelSessionStore, type KernelSessionStoreError } from "./session-store"

export type AgentRunRefusalReason =
  | "provider_prefixed_route"
  | "unknown_route"
  | "ambiguous_route"
  | "unknown_repository"
  | "provider_not_authenticated"
  | "model_not_available"
  | "invalid_wait_pairing"
  | "missing_parent_session"
  | "no_first_token"
  | "run_conflict"

/**
 * A refusal is the loud, machine-readable alternative to the silent hangs
 * this runner exists to kill: the dispatch is rejected with the reason a
 * caller (or its operator) can act on, and nothing keeps running behind it.
 */
export class AgentRunRefusalError extends Data.TaggedError("AgentRunRefusalError")<{
  readonly reason: AgentRunRefusalReason
  readonly detail: string
}> {}

export type AgentRunIngressError =
  | AgentRunRefusalError
  | AgentRunStoreError
  | KernelSessionStoreError
  | OpenCodeAdapterError
  | WorkspaceError
  | AgentWaitIngressError
  | Schema.SchemaError

export type AgentRunIngressPort = {
  readonly register: (
    input: AgentRunSubmissionType,
    now: Date,
  ) => Effect.Effect<AgentRunReceipt, AgentRunIngressError>
}

export const AgentRunIngress = Context.Service<AgentRunIngressPort>(
  "workflowd/kernel/AgentRunIngress",
)

/**
 * The session-spawning surface the ingress and watchdog need from the
 * OpenCode adapter. A separate service tag so tests provide a fake without
 * standing up the full adapter.
 */
export type AgentRunProviderPort = Pick<
  OpenCodeAdapter,
  | "createSession"
  | "promptSession"
  | "abortSession"
  | "listProviders"
  | "listModels"
  | "sessionTelemetry"
>

export const AgentRunProvider = Context.Service<AgentRunProviderPort>(
  "workflowd/kernel/AgentRunProvider",
)

export type AgentRunWorktreesPort = {
  readonly create: (input: {
    readonly repository: string
    readonly directory: string
    readonly branch: string
  }) => Effect.Effect<void, WorkspaceError>
}

export const AgentRunWorktrees = Context.Service<AgentRunWorktreesPort>(
  "workflowd/kernel/AgentRunWorktrees",
)

/**
 * Creates the run's git worktree inside the allow-listed repository. Hooks
 * are disabled the same way the managed PR workspace does it, and an
 * existing directory short-circuits so a crashed dispatch can be retried.
 */
export const gitAgentRunWorktrees: AgentRunWorktreesPort = {
  create: (input) =>
    Effect.gen(function* () {
      if (yield* pathExists(input.directory)) return
      yield* runWorkspaceCommand("create agent-run worktree", [
        "git",
        "-C",
        input.repository,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "-B",
        input.branch,
        input.directory,
        "HEAD",
      ])
    }),
}

export type AgentRunIngressOptions = {
  readonly routes: ReadonlyArray<AgentRunRoute>
  readonly repositories: ReadonlyArray<AgentRunRepository>
  readonly agent: string
  readonly worktreeRoot: string
  readonly verifyTimeoutMs: number
  readonly verifyPollIntervalMs: number
  readonly maxAttempts: number
  readonly identity: AgentCompletionSourceIdentity
}

export const agentRunIdentifiers = (input: {
  readonly route: string
  readonly repository: string
  readonly prompt: string
  readonly parentSessionId: string | null
  readonly resumePrompt: string | null
  readonly idempotencyKey?: string | undefined
}) => {
  const identity =
    input.idempotencyKey ??
    [
      input.route,
      input.repository,
      input.prompt,
      input.parentSessionId ?? "",
      input.resumePrompt ?? "",
    ].join("\0")
  const digest = createHash("sha256").update(identity, "utf8").digest("hex")
  return {
    runId: `agent-run-${digest}`,
    resourceId: `agent-run-resource-${digest}`,
    short: digest.slice(0, 16),
  }
}

/** Kernel custody ids are a pure function of the native OpenCode session id
 * so any caller holding a native id can name the session to wait_for_agent. */
export const opencodeSessionCustodyId = (nativeSessionId: string) =>
  `opencode-session-${nativeSessionId}`

const promptSha256 = (prompt: string) => createHash("sha256").update(prompt, "utf8").digest("hex")

const refuse = (reason: AgentRunRefusalReason, detail: string) =>
  new AgentRunRefusalError({ reason, detail })

const make = (options: AgentRunIngressOptions) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    const sessions = yield* KernelSessionStore
    const provider = yield* AgentRunProvider
    const worktrees = yield* AgentRunWorktrees
    const waits = yield* AgentWaitIngress
    const claude = yield* ClaudeCli
    const signals = yield* WorkSignal

    /** Registers custody rows read-first so replays and shared parents are
     * duplicates rather than conflicts (createdAt differs across runs).
     * Resolution is by PATH first: a directory has one custody resource per
     * host, shared by every session working in it, whatever id first named
     * it. Returns the resource id actually holding the path. */
    const ensureResource = (input: {
      readonly resourceId: string
      readonly absolutePath: string
      readonly kind: "worktree" | "checkout"
      readonly createdAt: Date
    }) =>
      Effect.gen(function* () {
        const held = yield* sessions.readResourceByPath({
          owningHostId: options.identity.owningHostId,
          absolutePath: input.absolutePath,
        })
        if (held !== null && typeof held.resource_id === "string") {
          return held.resource_id
        }
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
      readonly kind?: "opencode" | "claude"
      readonly host?: string
    }) =>
      Effect.gen(function* () {
        const claude = input.kind === "claude"
        const claudeHost = input.host ?? options.identity.owningHostId
        const sessionId = claude
          ? claudeSessionCustodyId(input.nativeSessionId)
          : opencodeSessionCustodyId(input.nativeSessionId)
        const existing = yield* sessions.readSession(sessionId)
        if (existing !== null) return sessionId
        yield* sessions.registerSession({
          sessionId,
          providerKind: claude ? "claude" : "opencode",
          providerVersion: options.identity.providerVersion,
          providerId: claude ? CLAUDE_PROVIDER_ID : options.identity.providerId,
          serverId: claude ? claudeHost : options.identity.serverId,
          owningHostId: options.identity.owningHostId,
          endpointAlias: claude ? CLAUDE_ENDPOINT_ALIAS : options.identity.endpointAlias,
          endpointIdentity: claude
            ? claudeEndpointIdentity(claudeHost)
            : options.identity.endpointIdentity,
          nativeSessionId: input.nativeSessionId,
          resourceId: input.resourceId,
          createdAt: input.createdAt,
        })
        return sessionId
      })

    const preflightRoute = (route: AgentRunRoute) =>
      Effect.gen(function* () {
        const [providers, models] = yield* Effect.all(
          [provider.listProviders({}), provider.listModels({})],
          { concurrency: 2 },
        )
        if (!providers.includes(route.providerID)) {
          return yield* refuse(
            "provider_not_authenticated",
            `route ${route.name} resolves to provider ${route.providerID}, which the ` +
              "OpenCode server has no credentials for; the dispatch would hang and die",
          )
        }
        const available = models.some(
          (model) => model.providerID === route.providerID && model.id === route.modelID,
        )
        if (!available) {
          return yield* refuse(
            "model_not_available",
            `route ${route.name} resolves to model ${route.modelID}, which provider ` +
              `${route.providerID} does not serve`,
          )
        }
      })

    /** Polls the child's token counters until the first generated token, the
     * automated form of the "confirm nonzero output tokens" operator ritual. */
    const verifyFirstToken = (nativeSessionId: string) =>
      Effect.gen(function* () {
        const polls = Math.max(1, Math.ceil(options.verifyTimeoutMs / options.verifyPollIntervalMs))
        for (let poll = 0; poll < polls; poll += 1) {
          const telemetry = yield* provider.sessionTelemetry({ sessionID: nativeSessionId })
          if (telemetry !== undefined && telemetry.outputTokens > 0) {
            return telemetry.outputTokens
          }
          yield* Effect.sleep(options.verifyPollIntervalMs)
        }
        return null
      })

    /** Resolves the parent's working directory in its own harness: the
     * opencode server for opencode parents, the local session transcript
     * for claude parents. Refusal happens before anything is spawned. */
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
          if (!claude.hosts.includes(parent.host)) {
            return yield* refuse(
              "missing_parent_session",
              `no claude delivery route is configured for host ${parent.host}`,
            )
          }
          const exists = yield* claude.sessionExists({
            nativeSessionId: parent.nativeSessionId,
            directory: parent.directory,
            host: parent.host,
          })
          if (!exists) {
            return yield* refuse(
              "missing_parent_session",
              `claude session ${parent.nativeSessionId} has no transcript for ` +
                `directory ${parent.directory} on host ${parent.host} (or the host is unreachable)`,
            )
          }
          return parent.directory
        }
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
        // The wait's registration boundary is anchored at run creation, not
        // the request clock: a retry after a transient wait failure must not
        // move the boundary past a child answer that already completed, or
        // the completion source would quarantine it as stale.
        const receipt = yield* waits.register(
          {
            parentSessionId,
            childSessionId: run.childSessionId,
            resumePrompt: run.resumePrompt,
            idempotencyKey: `${run.runId}-wait`,
          },
          run.createdAt,
        )
        return {
          waitId: receipt.waitId,
          instanceId: receipt.instanceId,
          status: receipt.status,
        }
      })

    const dispatch = (
      run: AgentRunRecord,
      route: AgentRunRoute,
      target: {
        readonly repositoryDirectory: string
        readonly resourceId: string
        readonly short: string
      },
      now: Date,
    ) =>
      Effect.gen(function* () {
        let nativeSessionId = run.nativeSessionId
        if (run.state === "spawning") {
          // Another in-flight request holds the spawn; refusing here keeps
          // concurrent duplicates from ever creating a second session.
          return yield* refuse(
            "run_conflict",
            "an identical dispatch is already spawning this run; retry after it settles",
          )
        }
        if (run.state === "accepted" || nativeSessionId === null) {
          yield* store.claimSpawn({ runId: run.runId, now })
          yield* worktrees.create({
            repository: target.repositoryDirectory,
            directory: run.directory,
            branch: `agent-run/${target.short}`,
          })
          // Custody for the worktree is registered before the session is
          // created so the external-effect window holds as little
          // unrecorded state as possible.
          const resourceId = yield* ensureResource({
            resourceId: target.resourceId,
            absolutePath: run.directory,
            kind: "worktree",
            createdAt: run.createdAt,
          })
          const session = yield* provider.createSession({
            directory: run.directory,
            title: `workflowd ${run.runId}`,
            agent: run.agent,
            model: { providerID: route.providerID, modelID: route.modelID },
          })
          nativeSessionId = session.id
          const sessionId = yield* ensureSession({
            nativeSessionId,
            resourceId,
            createdAt: run.createdAt,
          })
          yield* store.markSpawned({
            runId: run.runId,
            resourceId,
            sessionId,
            nativeSessionId,
            now,
          })
          yield* provider.promptSession({
            sessionID: nativeSessionId,
            directory: run.directory,
            agent: run.agent,
            model: { providerID: route.providerID, modelID: route.modelID },
            text: run.prompt,
          })
        }
        const outputTokens = yield* verifyFirstToken(nativeSessionId)
        if (outputTokens === null) {
          yield* provider
            .abortSession({ sessionID: nativeSessionId, directory: run.directory })
            .pipe(Effect.ignore)
          const detail =
            `session ${nativeSessionId} generated no tokens within ` +
            `${options.verifyTimeoutMs}ms of dispatch; it was aborted`
          // A re-dispatch of an already-verified run whose session died is
          // the watchdog's to escalate; the refusal must still name the
          // real reason rather than a state conflict.
          yield* store
            .fail({ runId: run.runId, diagnostic: `no_first_token: ${detail}`, now })
            .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
          return yield* refuse("no_first_token", detail)
        }
        yield* store.markVerified({ runId: run.runId, outputTokens, now })
        yield* signals.wake("agent-run")
        return { nativeSessionId, outputTokens }
      })

    const register: AgentRunIngressPort["register"] = (input, now) =>
      Effect.gen(function* () {
        const submission = yield* Schema.decodeUnknownEffect(AgentRunSubmission)(input, {
          onExcessProperty: "error",
        })
        if (
          (submission.parentSessionId === undefined) !==
          (submission.resumePrompt === undefined)
        ) {
          return yield* refuse(
            "invalid_wait_pairing",
            "parentSessionId and resumePrompt must be provided together or not at all",
          )
        }
        const resolution = resolveAgentRunRoute(options.routes, submission.route)
        if (resolution.outcome === "refused") {
          return yield* refuse(
            resolution.reason,
            `route "${submission.route}" ${
              resolution.reason === "provider_prefixed_route"
                ? "is provider-prefixed; pass a configured route name or bare model id"
                : resolution.reason === "ambiguous_route"
                  ? "matches more than one configured route; pass the route name"
                  : "matches no configured route or model"
            }`,
          )
        }
        const repository = options.repositories.find(
          (candidate) => candidate.name === submission.repository,
        )
        if (repository === undefined) {
          return yield* refuse(
            "unknown_repository",
            `repository "${submission.repository}" is not in the dispatch allow-list`,
          )
        }
        yield* preflightRoute(resolution.route)
        const parentKind = submission.parentKind ?? "opencode"
        const parentHost = submission.parentHost ?? options.identity.owningHostId
        // The parent is validated before anything external is spawned so a
        // caller naming a dead parent gets a refusal, not an orphaned child.
        const parentDirectory =
          submission.parentSessionId === undefined
            ? undefined
            : yield* resolveParentDirectory({
                nativeSessionId: submission.parentSessionId,
                kind: parentKind,
                host: parentHost,
                directory: submission.parentDirectory,
              })
        const identifiers = agentRunIdentifiers({
          route: resolution.route.name,
          repository: submission.repository,
          prompt: submission.prompt,
          parentSessionId:
            submission.parentSessionId === undefined
              ? null
              : `${parentKind}@${parentHost}:${submission.parentSessionId}`,
          resumePrompt: submission.resumePrompt ?? null,
          idempotencyKey: submission.idempotencyKey,
        })
        const created = yield* store.create({
          runId: identifiers.runId,
          route: resolution.route.name,
          providerId: resolution.route.providerID,
          modelId: resolution.route.modelID,
          agent: options.agent,
          repository: repository.name,
          directory: join(options.worktreeRoot, "agent-runs", identifiers.short),
          prompt: submission.prompt,
          promptSha256: promptSha256(submission.prompt),
          parentSessionId: submission.parentSessionId ?? null,
          resumePrompt: submission.resumePrompt ?? null,
          maxAttempts: options.maxAttempts,
          createdAt: now,
        })
        const run = yield* store.read(identifiers.runId)
        if (run === null) {
          return yield* refuse("run_conflict", "run row vanished during dispatch")
        }
        if (run.state === "failed" || run.state === "operator_required") {
          return yield* refuse(
            "run_conflict",
            `a previous dispatch of this run ended in ${run.state}` +
              (run.diagnostic === null ? "" : `: ${run.diagnostic}`),
          )
        }
        const dispatched =
          run.state === "completed"
            ? {
                nativeSessionId: run.nativeSessionId ?? "",
                outputTokens: run.lastOutputTokens,
              }
            : yield* dispatch(
                run,
                resolution.route,
                {
                  repositoryDirectory: repository.directory,
                  resourceId: identifiers.resourceId,
                  short: identifiers.short,
                },
                now,
              )
        const childSessionId = opencodeSessionCustodyId(dispatched.nativeSessionId)
        const wait =
          submission.parentSessionId === undefined ||
          submission.resumePrompt === undefined ||
          parentDirectory === undefined
            ? undefined
            : yield* registerWait({
                runId: identifiers.runId,
                parentNativeSessionId: submission.parentSessionId,
                parentKind,
                parentHost,
                parentDirectory,
                childSessionId,
                resumePrompt: submission.resumePrompt,
                createdAt: run.createdAt,
                now,
              })
        return {
          runId: identifiers.runId,
          sessionId: childSessionId,
          nativeSessionId: dispatched.nativeSessionId,
          providerId: resolution.route.providerID,
          modelId: resolution.route.modelID,
          outputTokens: dispatched.outputTokens,
          status: created.status === "duplicate" ? ("duplicate" as const) : ("dispatched" as const),
          ...(wait === undefined ? {} : { wait }),
        }
      })

    return AgentRunIngress.of({ register })
  })

export const AgentRunIngressLive = (options: AgentRunIngressOptions) =>
  Layer.effect(AgentRunIngress, make(options))
