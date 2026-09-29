import { createHash } from "node:crypto"
import { join } from "node:path"
import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  AgentRunSubmission,
  resolveAgentRunRouteChoice,
  type AgentRunCodexRoute,
  type AgentRunReceipt,
  type AgentRunRepository,
  type AgentRunRoute,
  type AgentRunSubmission as AgentRunSubmissionType,
} from "../agent-run-contract"
import type { OpenCodeAdapter, OpenCodeAdapterError } from "../opencode/adapter"
import type { WorkspaceError } from "../workspace/errors"
import { WorkSignal } from "../work-signal"
import { AgentWaitIngress, type AgentWaitIngressError } from "./agent-wait-ingress"
import { AgentRunWorktrees } from "./agent-run-worktrees"
import { ClaudeCli } from "./claude-session"
import { makeAgentRunCodexDispatcher } from "./agent-run-codex"
import { makeAgentRunCustody } from "./agent-run-custody"
import { CODEX_PROVIDER_ID, CodexCli, codexSessionCustodyId } from "./codex-session"
import type { AgentCompletionSourceIdentity } from "./agent-handoff-store"
import { AgentRunStore, type AgentRunRecord, type AgentRunStoreError } from "./agent-run-store"
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

const make = (options: AgentRunIngressOptions) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    const sessions = yield* KernelSessionStore
    const provider = yield* AgentRunProvider
    const worktrees = yield* AgentRunWorktrees
    const waits = yield* AgentWaitIngress
    const claude = yield* ClaudeCli
    const codex = yield* CodexCli
    const signals = yield* WorkSignal
    const codexReadiness = yield* codex.preflight.pipe(Effect.result)
    if (codexReadiness._tag === "Failure") {
      yield* Effect.logWarning("Codex route unavailable at startup", codexReadiness.failure)
    }

    const { ensureResource, ensureSession, registerWait, resolveParentDirectory } =
      makeAgentRunCustody({ sessions, provider, waits, claude, options, refuse })

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
        return { nativeSessionId, outputTokens, kind: "opencode" as const }
      })

    const codexRuns = makeAgentRunCodexDispatcher({
      codex,
      store,
      worktrees,
      signals,
      ensureResource,
      ensureSession,
      refuse,
      verifyTimeoutMs: options.verifyTimeoutMs,
      progressWindowMs: options.progressWindowMs,
    })
    yield* codexRuns.recover

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
        const resolution = resolveAgentRunRouteChoice(
          options.routes,
          options.codexRoutes,
          submission.route,
        )
        if (resolution.outcome === "refused") {
          return yield* refuse(
            resolution.reason,
            routeRefusalDetail(submission.route, resolution.reason),
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
        if (resolution.provider === "codex" && submission.parentSessionId !== undefined) {
          // The completion source only observes opencode children, so a codex
          // child could never deliver a parent wake; refusing loudly beats
          // registering a watch that can never complete.
          return yield* refuse(
            "invalid_wait_pairing",
            "codex routes complete inline and support no parent wake yet; " +
              "dispatch without parentSessionId/resumePrompt and read the outcome later",
          )
        }
        if (resolution.provider === "opencode") {
          yield* preflightRoute(resolution.route)
        } else {
          if (codexReadiness._tag === "Failure") {
            const issue = codexReadiness.failure
            return yield* new AgentRunRefusalError({
              reason:
                issue.kind === "systemd_unavailable"
                  ? "systemd_unavailable"
                  : "provider_not_authenticated",
              detail: issue.detail,
            })
          }
        }
        return { submission, resolution, repository }
      })

    const register: AgentRunIngressPort["register"] = (input, now) =>
      Effect.gen(function* () {
        const { submission, resolution, repository } = yield* prepareRegistration(input)
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
          providerId:
            resolution.provider === "codex" ? CODEX_PROVIDER_ID : resolution.route.providerID,
          modelId:
            resolution.provider === "codex"
              ? (resolution.route.modelID ?? "<cli-default>")
              : resolution.route.modelID,
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
                kind:
                  run.providerId === CODEX_PROVIDER_ID ? ("codex" as const) : ("opencode" as const),
              }
            : resolution.provider === "codex"
              ? yield* codexRuns.dispatch(
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
        const childSessionId =
          dispatched.kind === "codex"
            ? codexSessionCustodyId(dispatched.nativeSessionId)
            : opencodeSessionCustodyId(dispatched.nativeSessionId)
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
        return {
          runId: identifiers.runId,
          sessionId: childSessionId,
          nativeSessionId: dispatched.nativeSessionId,
          providerId:
            resolution.provider === "codex" ? CODEX_PROVIDER_ID : resolution.route.providerID,
          modelId:
            resolution.provider === "codex"
              ? (resolution.route.modelID ?? "<cli-default>")
              : resolution.route.modelID,
          outputTokens: dispatched.outputTokens,
          status: created.status === "duplicate" ? ("duplicate" as const) : ("dispatched" as const),
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
        if (run.providerId === CODEX_PROVIDER_ID) {
          yield* codexRuns.cancel(run, now)
          return
        }
        if (run.nativeSessionId === null) {
          return yield* refuse("run_conflict", `run ${runId} has no provider session to cancel`)
        }
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
