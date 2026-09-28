import { createHash } from "node:crypto"
import { join } from "node:path"
import { Context, Data, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
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
import {
  CLAUDE_ENDPOINT_ALIAS,
  CLAUDE_PROVIDER_ID,
  ClaudeCli,
  claudeEndpointIdentity,
  claudeSessionCustodyId,
} from "./claude-session"
import {
  CODEX_ENDPOINT_ALIAS,
  CODEX_PROVIDER_ID,
  CodexCli,
  codexEndpointIdentity,
  codexFailureLooksUnauthenticated,
  codexSessionCustodyId,
  type CodexExecEvent,
  type CodexExit,
  type CodexRunProcess,
} from "./codex-session"
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
      readonly kind?: "opencode" | "claude" | "codex"
      readonly host?: string
    }) =>
      Effect.gen(function* () {
        const kind = input.kind ?? "opencode"
        const claudeHost = input.host ?? options.identity.owningHostId
        const sessionId =
          kind === "claude"
            ? claudeSessionCustodyId(input.nativeSessionId)
            : kind === "codex"
              ? codexSessionCustodyId(input.nativeSessionId)
              : opencodeSessionCustodyId(input.nativeSessionId)
        const existing = yield* sessions.readSession(sessionId)
        if (existing === null) {
          yield* sessions.registerSession({
            sessionId,
            providerKind: kind,
            providerVersion: options.identity.providerVersion,
            providerId:
              kind === "claude"
                ? CLAUDE_PROVIDER_ID
                : kind === "codex"
                  ? CODEX_PROVIDER_ID
                  : options.identity.providerId,
            serverId: kind === "claude" ? claudeHost : options.identity.serverId,
            owningHostId: options.identity.owningHostId,
            endpointAlias:
              kind === "claude"
                ? CLAUDE_ENDPOINT_ALIAS
                : kind === "codex"
                  ? CODEX_ENDPOINT_ALIAS
                  : options.identity.endpointAlias,
            endpointIdentity:
              kind === "claude"
                ? claudeEndpointIdentity(claudeHost)
                : kind === "codex"
                  ? codexEndpointIdentity(options.identity.owningHostId)
                  : options.identity.endpointIdentity,
            nativeSessionId: input.nativeSessionId,
            resourceId: input.resourceId,
            createdAt: input.createdAt,
          })
        }
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
     * for same-host claude parents. Cross-host claude parents register
     * optimistically — the transcript can only be probed on the owning
     * host, so a missing one surfaces loudly at wake delivery instead of
     * doubling remote round trips here. Refusal happens before anything is
     * spawned. */
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
              `host ${parent.host} is not on the claude-hosts allow-list; ` +
                "its sessions cannot be woken",
            )
          }
          if (parent.host !== options.identity.owningHostId) {
            return parent.directory
          }
          const exists = yield* claude.sessionExists({
            nativeSessionId: parent.nativeSessionId,
            directory: parent.directory,
          })
          if (!exists) {
            return yield* refuse(
              "missing_parent_session",
              `claude session ${parent.nativeSessionId} has no transcript for ` +
                `directory ${parent.directory} on this host`,
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
        return { nativeSessionId, outputTokens, kind: "opencode" as const }
      })

    /**
     * Codex runs execute as one synchronous `codex exec --json` subprocess
     * in the prepared worktree: the thread id arrives with the first event,
     * custody is registered, and the receipt returns at the first
     * model-output event (bounded by verifyTimeoutMs, like the opencode
     * first-token wait). Process exit is completion: a detached continuation
     * drains the rest of the event stream and completes or escalates the run
     * inline — there is deliberately no completion watch for codex, because
     * the completion source only observes opencode sessions.
     */
    type CodexFirstToken =
      | {
          readonly outcome: "generating"
          readonly threadId: string
          readonly firstMessage: string
        }
      | {
          readonly outcome: "refused"
          readonly reason: "provider_not_authenticated" | "no_first_token"
          readonly detail: string
        }

    type CodexObservation = {
      readonly result: CodexFirstToken
      readonly iterator: AsyncIterator<CodexExecEvent>
      readonly exited: Fiber.Fiber<CodexExit, WorkspaceError>
    }

    const observeCodexFirstToken = (process: CodexRunProcess, firstTokenTimeoutMs: number) =>
      Effect.gen(function* () {
        const iterator = process.events[Symbol.asyncIterator]()
        // The process fiber must outlive the dispatching HTTP request: the
        // receipt returns while codex is still streaming, and a scoped child
        // fiber dies with the request scope — taking the process group with
        // it (observed as `codex_failed: exit -1` the moment a client
        // disconnected after the receipt). Detach so only the drain fiber's
        // explicit interrupt or codex's own exit ends the process.
        const exited = yield* Effect.forkDetach(process.exited)
        let threadId: string | null = null
        let firstMessage: string | null = null
        const errors: string[] = []
        const streamed: Effect.Effect<CodexFirstToken> = Effect.gen(function* () {
          const pull = Effect.promise(() =>
            iterator.next().then(
              (next) => (next.done ? "closed" : next.value),
              () => "closed" as const,
            ),
          )
          for (;;) {
            const step = yield* pull
            if (step === "closed") {
              return {
                outcome: "refused" as const,
                reason: "no_first_token" as const,
                detail:
                  firstMessage !== null
                    ? "codex produced model output but never announced a thread id; the runner cannot custody it"
                    : "codex exited before producing model output",
              }
            }
            if (step.type === "thread.started") {
              threadId = step.threadId
            } else if (step.type === "agent_message") {
              if (firstMessage === null) firstMessage = step.text
              if (threadId !== null) {
                return { outcome: "generating" as const, threadId, firstMessage }
              }
            } else if (step.type === "error" || step.type === "turn.failed") {
              errors.push(step.message)
            }
          }
        })
        const timedOut: Effect.Effect<CodexFirstToken> = Effect.as(
          Effect.sleep(firstTokenTimeoutMs),
          {
            outcome: "refused" as const,
            reason: "no_first_token" as const,
            detail: `codex produced no model output within ${firstTokenTimeoutMs}ms of spawn`,
          },
        )
        const result = yield* Effect.race(streamed, timedOut)
        if (result.outcome === "generating") {
          return { result, iterator, exited } satisfies CodexObservation
        }
        // Refused. Give a process that is already dying a short grace period
        // to deliver its exit facts, then terminate whatever remains — a
        // refusal never leaves codex burning.
        const graceExit: CodexExit | null = yield* Effect.race(
          Fiber.join(exited),
          Effect.as(Effect.sleep(500), null),
        )
        if (graceExit === null) yield* Fiber.interrupt(exited).pipe(Effect.ignore)
        const authFailed =
          codexFailureLooksUnauthenticated(errors) ||
          (graceExit !== null && codexFailureLooksUnauthenticated([graceExit.stderr]))
        const reason = authFailed ? ("provider_not_authenticated" as const) : result.reason
        const detail = authFailed
          ? `${result.detail}: the codex CLI reported an authentication failure`
          : result.detail +
            (errors.length === 0 ? "" : `; last error: ${errors.at(-1)}`) +
            (graceExit !== null && graceExit.stderr !== ""
              ? `; stderr: ${graceExit.stderr.slice(0, 300)}`
              : "")
        return {
          result: { outcome: "refused" as const, reason, detail },
          iterator,
          exited,
        } satisfies CodexObservation
      })

    const dispatchCodex = (
      run: AgentRunRecord,
      route: AgentRunCodexRoute,
      target: {
        readonly repositoryDirectory: string
        readonly resourceId: string
        readonly short: string
      },
      now: Date,
    ) =>
      Effect.gen(function* () {
        if (run.state === "spawning") {
          return yield* refuse(
            "run_conflict",
            "an identical dispatch is already spawning this run; retry after it settles",
          )
        }
        if (run.state === "accepted" || run.nativeSessionId === null) {
          yield* store.claimSpawn({ runId: run.runId, now })
          yield* worktrees.create({
            repository: target.repositoryDirectory,
            directory: run.directory,
            branch: `agent-run/${target.short}`,
          })
          const resourceId = yield* ensureResource({
            resourceId: target.resourceId,
            absolutePath: run.directory,
            kind: "worktree",
            createdAt: run.createdAt,
          })
          const process = yield* codex.spawn({
            directory: run.directory,
            prompt: run.prompt,
            model: route.modelID,
          })
          const observed = yield* observeCodexFirstToken(process, options.verifyTimeoutMs)
          if (observed.result.outcome === "refused") {
            yield* store
              .fail({
                runId: run.runId,
                diagnostic: `${observed.result.reason}: ${observed.result.detail}`,
                now,
              })
              .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
            return yield* refuse(observed.result.reason, observed.result.detail)
          }
          const threadId = observed.result.threadId
          yield* ensureSession({
            nativeSessionId: threadId,
            resourceId,
            createdAt: run.createdAt,
            kind: "codex",
          })
          yield* store.markSpawned({
            runId: run.runId,
            resourceId,
            sessionId: codexSessionCustodyId(threadId),
            nativeSessionId: threadId,
            now,
          })
          yield* store.markVerified({
            runId: run.runId,
            // The receipt needs a positive count before usage exists; the
            // inline completion records the real turn.completed tokens.
            outputTokens: 1,
            now,
          })
          yield* Effect.forkDetach(
            completeCodexInline({
              runId: run.runId,
              iterator: observed.iterator,
              exited: observed.exited,
              initialFinalMessage: observed.result.firstMessage,
              stallWindowMs: options.progressWindowMs,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("codex inline completion failed", { runId: run.runId, cause }),
              ),
            ),
          )
          yield* signals.wake("agent-run")
          return { nativeSessionId: threadId, outputTokens: 1, kind: "codex" as const }
        }
        if (run.state === "verified" && run.nativeSessionId !== null) {
          // A prior request verified this run and its inline completion is
          // still draining; the row carries the receipt facts.
          return {
            nativeSessionId: run.nativeSessionId,
            outputTokens: run.lastOutputTokens,
            kind: "codex" as const,
          }
        }
        return yield* refuse(
          "run_conflict",
          `a previous dispatch left this run ${run.state}; codex processes cannot be re-observed`,
        )
      })

    const completeCodexInline = (input: {
      readonly runId: string
      readonly iterator: AsyncIterator<CodexExecEvent>
      readonly exited: Fiber.Fiber<CodexExit, WorkspaceError>
      /** The first-token message the dispatch already consumed; the final
       * agent_message of the run is the latest one seen across both phases. */
      readonly initialFinalMessage: string
      readonly stallWindowMs: number
    }) =>
      Effect.gen(function* () {
        let finalMessage: string | null = input.initialFinalMessage
        let outputTokens: number | null = null
        let turnFailed: string | null = null
        let stalled = false
        for (;;) {
          const next = yield* Effect.promise(() =>
            input.iterator.next().then(
              (result) => (result.done ? "closed" : result.value),
              () => "closed" as const,
            ),
          ).pipe(Effect.timeoutOption(input.stallWindowMs))
          if (Option.isNone(next)) {
            stalled = true
            break
          }
          if (next.value === "closed") break
          const event = next.value
          if (event.type === "agent_message") {
            finalMessage = event.text
          } else if (event.type === "turn.completed") {
            outputTokens = event.outputTokens
          } else if (event.type === "turn.failed") {
            turnFailed = event.message
          } else if (event.type === "error") {
            turnFailed = turnFailed ?? event.message
          }
        }
        if (stalled) {
          yield* Fiber.interrupt(input.exited).pipe(Effect.ignore)
        }
        const exit: Exit.Exit<CodexExit, WorkspaceError> = yield* Effect.exit(
          Fiber.join(input.exited),
        )
        const exitCode = Exit.isSuccess(exit) ? exit.value.exitCode : -1
        if (!stalled && exitCode === 0 && finalMessage !== null) {
          if (outputTokens !== null) {
            yield* store
              .recordProgress({ runId: input.runId, outputTokens, now: new Date() })
              .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
          }
          yield* store
            .complete({ runId: input.runId, now: new Date() })
            .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
          return
        }
        const diagnostic = stalled
          ? `codex_stalled: no codex event for ${input.stallWindowMs}ms; the process group was terminated`
          : `codex_failed: exit ${exitCode}` +
            (turnFailed === null ? "" : `; ${turnFailed}`) +
            (Exit.isSuccess(exit) && exit.value.stderr !== ""
              ? `; stderr: ${exit.value.stderr.slice(0, 500)}`
              : "")
        yield* store
          .operatorRequired({ runId: input.runId, diagnostic, now: new Date() })
          .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
      })

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
          yield* codex.preflight.pipe(
            Effect.mapError(
              (issue) =>
                new AgentRunRefusalError({
                  reason: "provider_not_authenticated",
                  detail: issue.detail,
                }),
            ),
          )
        }
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
              ? (resolution.route.modelID ?? "")
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
              ? yield* dispatchCodex(
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
              ? (resolution.route.modelID ?? "")
              : resolution.route.modelID,
          outputTokens: dispatched.outputTokens,
          status: created.status === "duplicate" ? ("duplicate" as const) : ("dispatched" as const),
          ...(wait === undefined ? {} : { wait }),
        }
      })

    return AgentRunIngress.of({ register })
  })

export const AgentRunIngressLive = (options: AgentRunIngressOptions) =>
  Layer.effect(AgentRunIngress, make(options))
