import { canonicalJson } from "./session-store-support"
import { ExecutionDiscovery } from "../execution-capabilities"
import {
  resolveExecutionSelection,
  type RequestedSelection,
  type ResolvedSelection,
  type SelectionRefusal,
} from "../execution-selection"
import { OpenCodeMailbox } from "../resident/opencode"
import { WorkerIdentity } from "../worker-identity/service"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import {
  AgentRunSubmission,
  resolveAgentRunRouteChoice,
  type AgentRunCodexRoute,
  type AgentRunClaudeRoute,
  type AgentRunReceipt,
  type AgentRunRepository,
  type AgentRunRoute,
  type AgentRunRouteChoice,
  type AgentRunSubmission as AgentRunSubmissionType,
} from "../agent-run-contract"
import type { OpenCodeAdapter, OpenCodeAdapterError } from "../opencode/adapter"
import { WorkspaceError } from "../workspace/errors"
import { WorkSignal } from "../work-signal"
import { AgentWaitIngress, type AgentWaitIngressError } from "./agent-wait-ingress"
import { AgentRunWorktrees } from "./agent-run-worktrees"
import { CLAUDE_PROVIDER_ID, ClaudeCli, claudeSessionCustodyId } from "./claude-session"
import { ClaudeDispatchCli } from "./claude-dispatch"
import { makeAgentRunCliDispatcher } from "./agent-run-cli"
import { makeAgentRunCustody } from "./agent-run-custody"
import { CODEX_PROVIDER_ID, CodexCli, codexSessionCustodyId } from "./codex-session"
import type { AgentCompletionSourceIdentity } from "./agent-handoff-store"
import {
  AgentRunStore,
  AgentRunStoreConflictError,
  agentRunExecutorKind,
  type AgentRunRecord,
  type AgentRunStoreError,
} from "./agent-run-store"
import type { CliPort, CliPreflightError } from "./cli-process-contract"
import { KernelSessionStore, type KernelSessionStoreError } from "./session-store"

export type AgentRunRefusalReason =
  | "provider_prefixed_route"
  | "unknown_route"
  | "ambiguous_route"
  | "unknown_repository"
  | "provider_not_authenticated"
  | "systemd_unavailable"
  | "model_not_available"
  | "invalid_wait_pairing"
  | "missing_parent_session"
  | "no_first_token"
  | "run_conflict"
  | "invalid_selection"
  | SelectionRefusal

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
  readonly cancel: (runId: string, now: Date) => Effect.Effect<void, AgentRunIngressError>
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

export type AgentRunIngressOptions = {
  readonly routes: ReadonlyArray<AgentRunRoute>
  /** Codex CLI routes, resolved after `routes` and refused ambiguous when a
   * name or bare model id is served by both providers. */
  readonly codexRoutes: ReadonlyArray<AgentRunCodexRoute>
  readonly claudeRoutes?: ReadonlyArray<AgentRunClaudeRoute>
  readonly repositories: ReadonlyArray<AgentRunRepository>
  readonly agent: string
  readonly worktreeRoot: string
  readonly verifyTimeoutMs: number
  readonly verifyPollIntervalMs: number
  /** Bounds how long a codex run may stream no events before its inline
   * completion terminates the process and escalates (same knob as the
   * opencode stall window). */
  readonly progressWindowMs: number
  readonly maxAttempts: number
  /** Hosts (besides the daemon host) whose Claude sessions may be named as
   * parents; their wakes are delivered by that host's workflowd runner. */
  readonly claudeHosts: ReadonlyArray<string>
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

const routeRefusalDetail = (
  route: string,
  reason: "provider_prefixed_route" | "unknown_route" | "ambiguous_route",
) => {
  if (reason === "provider_prefixed_route") {
    return `route "${route}" is provider-prefixed; pass a configured route name or bare model id`
  }
  if (reason === "ambiguous_route") {
    return `route "${route}" matches more than one configured route; pass the route name`
  }
  return `route "${route}" matches no configured route or model`
}

const choiceForSelection = (
  selection: ResolvedSelection,
  name: string,
): Extract<AgentRunRouteChoice, { outcome: "resolved" }> =>
  selection.executorKind === "opencode"
    ? {
        outcome: "resolved",
        provider: "opencode",
        route: {
          name,
          providerID: selection.provider ?? "",
          modelID: selection.selectionModel ?? "",
        },
      }
    : {
        outcome: "resolved",
        provider: selection.executorKind,
        route: { name, modelID: selection.model },
      }

const make = (options: AgentRunIngressOptions) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    const sessions = yield* KernelSessionStore
    const providerOption = yield* Effect.serviceOption(AgentRunProvider)
    const provider = Option.getOrUndefined(providerOption)
    const discovery = yield* Effect.serviceOption(ExecutionDiscovery)
    const worktrees = yield* AgentRunWorktrees
    const waits = Option.getOrUndefined(yield* Effect.serviceOption(AgentWaitIngress))
    const claude = Option.getOrUndefined(yield* Effect.serviceOption(ClaudeCli))
    const identity = yield* Effect.serviceOption(WorkerIdentity)
    const mailbox = yield* Effect.serviceOption(OpenCodeMailbox)
    const workerPrompt = (run: AgentRunRecord) =>
      Option.isSome(identity)
        ? identity.value
            .provision(run)
            .pipe(Effect.map((instruction) => `${instruction}\n\n${run.prompt}`))
        : Effect.succeed(run.prompt)
    const codex = yield* CodexCli
    const claudeDispatchOption = yield* Effect.serviceOption(ClaudeDispatchCli)
    const claudeDispatch = Option.getOrUndefined(claudeDispatchOption)
    const signals = yield* WorkSignal
    const currentReadiness = (cli: CliPort | undefined, kind: string) =>
      (
        cli?.preflight ??
        Effect.fail({ kind: "cli_unusable" as const, detail: `${kind} executor is disabled` })
      ).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.fail({
              kind: "cli_unusable",
              detail: `${kind} preflight did not complete within 5 seconds`,
            } satisfies CliPreflightError),
        }),
        Effect.result,
      )
    const codexReadiness = yield* currentReadiness(codex, "Codex")
    if (codexReadiness._tag === "Failure") {
      yield* Effect.logWarning("Codex route unavailable at startup", codexReadiness.failure)
    }
    const claudeReadiness = yield* currentReadiness(claudeDispatch, "Claude")
    if (claudeReadiness._tag === "Failure" && (options.claudeRoutes?.length ?? 0) > 0)
      yield* Effect.logWarning("Claude CLI route unavailable at startup", claudeReadiness.failure)

    const { ensureResource, ensureSession, registerWait, resolveParentDirectory } =
      makeAgentRunCustody({ sessions, provider, waits, claude, options, refuse })

    const preflightRoute = (route: AgentRunRoute) =>
      Effect.gen(function* () {
        if (provider === undefined)
          return yield* refuse("executor_unavailable", "OpenCode executor is disabled")
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
        if (provider === undefined)
          return yield* refuse("executor_unavailable", "OpenCode executor is disabled")
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
        if (provider === undefined)
          return yield* refuse("executor_unavailable", "OpenCode executor is disabled")
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
            model: {
              providerID: route.providerID,
              modelID: route.modelID,
              ...(run.resolvedSelection?.thinking.variant === undefined
                ? {}
                : { variant: run.resolvedSelection.thinking.variant }),
            },
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
          const mailboxInstructions = Option.isSome(mailbox)
            ? yield* mailbox.value
                .prepare(run.runId)
                .pipe(
                  Effect.mapError(
                    (cause) => new WorkspaceError({ operation: "prepare OpenCode mailbox", cause }),
                  ),
                )
            : ""
          yield* provider.promptSession({
            sessionID: nativeSessionId,
            directory: run.directory,
            agent: run.agent,
            model: {
              providerID: route.providerID,
              modelID: route.modelID,
              ...(run.resolvedSelection?.thinking.variant === undefined
                ? {}
                : { variant: run.resolvedSelection.thinking.variant }),
            },
            text: `${mailboxInstructions}\n\n${yield* workerPrompt(run)}`.trim(),
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
        return { nativeSessionId, outputTokens, kind: "opencode" as const }
      })

    const codexRuns = makeAgentRunCliDispatcher({
      cli: codex,
      executor: {
        kind: "codex",
        sessionCustodyId: codexSessionCustodyId,
      },
      store,
      worktrees,
      signals,
      ensureResource,
      ensureSession,
      refuse,
      verifyTimeoutMs: options.verifyTimeoutMs,
      progressWindowMs: options.progressWindowMs,
      workerPrompt,
    })
    yield* codexRuns.recover
    const claudeRuns =
      claudeDispatch === undefined
        ? undefined
        : makeAgentRunCliDispatcher({
            cli: claudeDispatch,
            executor: {
              kind: "claude",
              sessionCustodyId: claudeSessionCustodyId,
            },
            store,
            worktrees,
            signals,
            ensureResource,
            ensureSession,
            refuse,
            verifyTimeoutMs: options.verifyTimeoutMs,
            progressWindowMs: options.progressWindowMs,
          })
    if (claudeRuns !== undefined) yield* claudeRuns.recover

    const registerWaitIfPaired = (input: {
      readonly submission: AgentRunSubmissionType
      readonly parentKind: "opencode" | "claude"
      readonly parentHost: string
      readonly parentDirectory: string | undefined
      readonly runId: string
      readonly childSessionId: string
      readonly createdAt: Date
      readonly now: Date
    }) => {
      const { submission, parentDirectory } = input
      if (
        submission.parentSessionId === undefined ||
        submission.resumePrompt === undefined ||
        parentDirectory === undefined
      ) {
        return Effect.succeed(undefined)
      }
      return registerWait({
        runId: input.runId,
        parentNativeSessionId: submission.parentSessionId,
        parentKind: input.parentKind,
        parentHost: input.parentHost,
        parentDirectory,
        childSessionId: input.childSessionId,
        resumePrompt: submission.resumePrompt,
        createdAt: input.createdAt,
        now: input.now,
      })
    }

    const resolveWaitParentDirectory = (
      submission: AgentRunSubmissionType,
      parentKind: "opencode" | "claude",
      parentHost: string,
    ) =>
      submission.parentSessionId === undefined
        ? Effect.succeed(undefined)
        : resolveParentDirectory({
            nativeSessionId: submission.parentSessionId,
            kind: parentKind,
            host: parentHost,
            directory: submission.parentDirectory,
          })

    const historicalSelection = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const custody = run.sessionId === null ? null : yield* sessions.readSession(run.sessionId)
        if (run.sessionId !== null && custody === null)
          return yield* refuse("run_conflict", "Historical session custody is missing")
        const scope =
          custody === null
            ? {
                owning_host_id: options.identity.owningHostId,
                server_id: options.identity.serverId,
              }
            : yield* Schema.decodeUnknownEffect(
                Schema.Struct({ owning_host_id: Schema.String, server_id: Schema.String }),
              )(custody)
        const kind = agentRunExecutorKind(run)
        const model = run.modelId === "<cli-default>" ? null : run.modelId
        return {
          host: scope.owning_host_id,
          executor: kind === "opencode" ? `opencode:${scope.server_id}` : `${kind}:local`,
          executorKind: kind,
          provider: kind === "opencode" ? run.providerId : null,
          // Historical OpenCode rows record the catalog ID, not its native identity.
          model: kind === "opencode" ? null : model,
          selectionModel: model,
          thinking: {},
          availability: "unknown",
          evidence: "configured",
        } satisfies ResolvedSelection
      })

    const prepareRegistration = (input: Parameters<AgentRunIngressPort["register"]>[0]) =>
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
        if ((submission.route === undefined) === (submission.model === undefined))
          return yield* refuse("invalid_selection", "Provide exactly one of route or model")
        if (
          submission.route !== undefined &&
          (submission.provider !== undefined ||
            submission.executor !== undefined ||
            submission.modelIdentity !== undefined)
        )
          return yield* refuse(
            "invalid_selection",
            "Use model for explicit provider/executor selection; route is a configured alias",
          )
        const requested: RequestedSelection = {
          ...(submission.route === undefined ? {} : { route: submission.route }),
          ...(submission.model === undefined ? {} : { model: submission.model }),
          ...(submission.provider === undefined ? {} : { provider: submission.provider }),
          ...(submission.executor === undefined ? {} : { executor: submission.executor }),
          ...(submission.modelIdentity === undefined
            ? {}
            : { modelIdentity: submission.modelIdentity }),
          ...(submission.thinking === undefined ? {} : { thinking: submission.thinking }),
          ...(submission.allowUnknownAccess === undefined
            ? {}
            : { allowUnknownAccess: submission.allowUnknownAccess }),
        }
        let resolution: Extract<AgentRunRouteChoice, { outcome: "resolved" }>
        let selection: ResolvedSelection
        // A duplicate uses its immutable accepted choice, even after catalog refresh.
        const aliasForIdentity =
          submission.route === undefined
            ? undefined
            : resolveAgentRunRouteChoice(
                options.routes,
                options.codexRoutes,
                submission.route,
                options.claudeRoutes,
              )
        const identityRoute =
          submission.model === undefined
            ? aliasForIdentity?.outcome === "resolved"
              ? aliasForIdentity.route.name
              : (submission.route ?? "")
            : `selection-${promptSha256(canonicalJson(requested))}`
        const keyed = yield* store.read(
          agentRunIdentifiers({
            route: identityRoute,
            repository: submission.repository,
            prompt: submission.prompt,
            parentSessionId:
              submission.parentSessionId === undefined
                ? null
                : `${submission.parentKind ?? "opencode"}@${submission.parentHost ?? options.identity.owningHostId}:${submission.parentSessionId}`,
            resumePrompt: submission.resumePrompt ?? null,
            idempotencyKey: submission.idempotencyKey,
          }).runId,
        )
        if (keyed?.resolvedSelection != null) {
          // Immutable replay needs no current catalog; create still compares the
          // complete requested document and rejects changed keyed choices.
          selection = keyed.resolvedSelection
          resolution = choiceForSelection(selection, keyed.route)
        } else if (keyed !== null) {
          if (
            submission.model !== undefined ||
            submission.thinking !== undefined ||
            identityRoute !== keyed.route
          )
            return yield* new AgentRunStoreConflictError({
              runId: keyed.runId,
              detail: "Historical accepted choice cannot confirm a changed selection",
            })
          selection = yield* historicalSelection(keyed)
          resolution = choiceForSelection(selection, keyed.route)
        } else if (submission.model !== undefined) {
          if (Option.isNone(discovery))
            return yield* refuse("executor_unavailable", "Capability discovery is disabled")
          const catalog = yield* discovery.value
            .list()
            .pipe(
              Effect.mapError(() =>
                refuse("executor_unavailable", "Capability discovery unavailable"),
              ),
            )
          const selected = resolveExecutionSelection(catalog, requested)
          if (selected.outcome === "refused")
            return yield* refuse(
              selected.reason,
              `Selection refused: ${selected.reason}; consult list_execution_capabilities`,
            )
          selection = selected.selection
          resolution = choiceForSelection(selection, identityRoute)
        } else {
          const alias = resolveAgentRunRouteChoice(
            options.routes,
            options.codexRoutes,
            submission.route!,
            options.claudeRoutes,
          )
          if (alias.outcome === "refused")
            return yield* refuse(alias.reason, routeRefusalDetail(submission.route!, alias.reason))
          resolution = alias
          selection = {
            host: options.identity.owningHostId,
            executor:
              alias.provider === "opencode"
                ? `opencode:${options.identity.serverId}`
                : `${alias.provider}:local`,
            executorKind: alias.provider,
            provider: alias.provider === "opencode" ? alias.route.providerID : null,
            model: alias.route.modelID,
            selectionModel: alias.route.modelID,
            thinking: {},
            availability: "unknown",
            evidence: "configured",
          }
          if (submission.thinking !== undefined && Object.keys(submission.thinking).length > 0) {
            if (alias.provider !== "opencode" && alias.route.modelID === null)
              return yield* refuse(
                "unsupported_thinking",
                "This CLI alias pins no model, so thinking cannot be verified before execution",
              )
            if (alias.provider === "claude") {
              return yield* refuse(
                "unsupported_thinking",
                "Claude cannot verify per-model thinking or silent effort caps before execution",
              )
            } else {
              if (Option.isNone(discovery))
                return yield* refuse(
                  "unsupported_thinking",
                  "Thinking requires native capability metadata",
                )
              const catalog = yield* discovery.value
                .list()
                .pipe(
                  Effect.mapError(() =>
                    refuse("executor_unavailable", "Capability discovery unavailable"),
                  ),
                )
              const selected = resolveExecutionSelection(catalog, {
                model: alias.route.modelID ?? "",
                modelIdentity: alias.provider === "opencode" ? "catalog" : "native",
                executor: selection.executor,
                ...(alias.provider === "opencode" ? { provider: alias.route.providerID } : {}),
                thinking: submission.thinking,
                allowUnknownAccess: true,
              })
              if (selected.outcome === "refused")
                return yield* refuse(selected.reason, `Alias thinking refused: ${selected.reason}`)
              selection = selected.selection
              resolution = choiceForSelection(selection, alias.route.name)
            }
          }
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
        if (resolution.provider !== "opencode" && submission.parentSessionId !== undefined) {
          // The completion source only observes opencode children, so a codex
          // child could never deliver a parent wake; refusing loudly beats
          // registering a watch that can never complete.
          return yield* refuse(
            "invalid_wait_pairing",
            `${resolution.provider} CLI routes complete inline and support no parent wake yet; ` +
              "dispatch without parentSessionId/resumePrompt and read the outcome later",
          )
        }
        if (keyed !== null && keyed.state !== "accepted") {
          // Already-launched duplicates need no fresh launch preflight.
        } else if (resolution.provider === "opencode" && submission.model === undefined) {
          yield* preflightRoute(resolution.route)
        } else if (resolution.provider !== "opencode") {
          const readiness = yield* currentReadiness(
            resolution.provider === "claude" ? claudeDispatch : codex,
            resolution.provider,
          )
          if (readiness._tag === "Failure") {
            const issue = readiness.failure
            return yield* new AgentRunRefusalError({
              reason:
                issue.kind === "systemd_unavailable"
                  ? "systemd_unavailable"
                  : issue.kind === "not_authenticated"
                    ? "provider_not_authenticated"
                    : "executor_unavailable",
              detail: issue.detail,
            })
          }
        }
        return { submission, resolution, repository, requested, selection, accepted: keyed }
      })

    const register: AgentRunIngressPort["register"] = (input, now) =>
      Effect.gen(function* () {
        const { submission, resolution, repository, requested, selection, accepted } =
          yield* prepareRegistration(input)
        const providerId =
          accepted?.providerId ??
          (resolution.provider === "opencode"
            ? resolution.route.providerID
            : resolution.provider === "claude"
              ? CLAUDE_PROVIDER_ID
              : CODEX_PROVIDER_ID)
        const modelId = accepted?.modelId ?? resolution.route.modelID ?? "<cli-default>"
        const parentKind = submission.parentKind ?? "opencode"
        const parentHost = submission.parentHost ?? options.identity.owningHostId
        // The parent is validated before anything external is spawned so a
        // caller naming a dead parent gets a refusal, not an orphaned child.
        const parentDirectory = yield* resolveWaitParentDirectory(
          submission,
          parentKind,
          parentHost,
        )
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
          providerId,
          modelId,
          executorKind: selection.executorKind,
          requestedSelection: requested,
          resolvedSelection: selection,
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
        const immutableReceipt =
          run.state === "completed" ||
          (resolution.provider !== "opencode" &&
            run.state === "verified" &&
            run.nativeSessionId !== null)
        const nativeRuns = resolution.provider === "claude" ? claudeRuns : codexRuns
        const dispatched = immutableReceipt
          ? {
              nativeSessionId: run.nativeSessionId ?? "",
              outputTokens: run.lastOutputTokens,
              kind: resolution.provider,
            }
          : resolution.provider !== "opencode"
            ? yield* nativeRuns === undefined
                ? refuse("executor_unavailable", "Claude executor is disabled")
                : nativeRuns.dispatch(
                    run,
                    resolution.route,
                    {
                      repositoryDirectory: repository.directory,
                      resourceId: identifiers.resourceId,
                      short: identifiers.short,
                    },
                    now,
                  )
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
        const childSessionId = {
          claude: claudeSessionCustodyId,
          codex: codexSessionCustodyId,
          opencode: opencodeSessionCustodyId,
        }[dispatched.kind](dispatched.nativeSessionId)
        const wait = yield* registerWaitIfPaired({
          submission,
          parentKind,
          parentHost,
          parentDirectory,
          runId: identifiers.runId,
          childSessionId,
          createdAt: run.createdAt,
          now,
        })
        const resolvedRun = yield* store.read(identifiers.runId)
        return {
          runId: identifiers.runId,
          sessionId: childSessionId,
          nativeSessionId: dispatched.nativeSessionId,
          providerId,
          modelId,
          outputTokens: dispatched.outputTokens,
          status: created.status === "duplicate" ? ("duplicate" as const) : ("dispatched" as const),
          ...(run.requestedSelection == null ? {} : { requestedSelection: run.requestedSelection }),
          resolvedSelection: resolvedRun?.resolvedSelection ?? selection,
          ...(wait === undefined ? {} : { wait }),
        }
      })

    const cancel: AgentRunIngressPort["cancel"] = (runId, now) =>
      Effect.gen(function* () {
        const run = yield* store.read(runId)
        if (run === null) return yield* refuse("run_conflict", `run ${runId} does not exist`)
        if (run.state === "completed" || run.state === "cancelled" || run.state === "failed") {
          return yield* refuse("run_conflict", `run ${runId} is already ${run.state}`)
        }
        if (agentRunExecutorKind(run) === "codex") {
          yield* codexRuns.cancel(run, now)
          return
        }
        if (agentRunExecutorKind(run) === "claude") {
          if (claudeRuns === undefined)
            return yield* refuse("executor_unavailable", "Claude executor is disabled")
          yield* claudeRuns.cancel(run, now)
          return
        }
        if (run.nativeSessionId === null) {
          return yield* refuse("run_conflict", `run ${runId} has no provider session to cancel`)
        }
        if (provider === undefined)
          return yield* refuse("executor_unavailable", "OpenCode executor is disabled")
        const stopped = yield* provider.abortSession({
          sessionID: run.nativeSessionId,
          directory: run.directory,
        })
        if (!stopped) return yield* refuse("run_conflict", `run ${runId} could not be stopped`)
        yield* store.cancel({ runId, now })
      })

    return AgentRunIngress.of({ register, cancel })
  })

export const AgentRunIngressLive = (options: AgentRunIngressOptions) =>
  Layer.effect(AgentRunIngress, make(options))
