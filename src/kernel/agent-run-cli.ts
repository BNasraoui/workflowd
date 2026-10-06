import {
  type CliPort,
  type CliEvent,
  type CliExit,
  type CliRunProcess,
} from "./cli-process-contract"
import { ExecutionSelectionError } from "../execution-selection"
import { Effect, Exit, Fiber, Option } from "effect"
import type { AgentRunCliRoute } from "../agent-run-contract"
import { WorkspaceError } from "../workspace/errors"
import type { SandboxDispatchPort } from "../sandbox/dispatch"
import type { WorkSignalPort } from "../work-signal"
import type { AgentRunRefusalError } from "./agent-run-ingress"
import type { makeAgentRunCustody } from "./agent-run-custody"
import { codexFailureLooksUnauthenticated } from "./codex-session"
import type { AgentRunRecord, AgentRunStorePort } from "./agent-run-store"
import { createAgentRunWorktree, type AgentRunWorktreesPort } from "./agent-run-worktrees"

type RefusalReason =
  | "provider_not_authenticated"
  | "no_first_token"
  | "run_conflict"
  | "unsupported_thinking"
  | "model_not_available"
type Custody = ReturnType<typeof makeAgentRunCustody>
export type AgentRunCliStore = Partial<Pick<AgentRunStorePort, "recordResolvedSelection">> &
  Pick<
    AgentRunStorePort,
    | "claimSpawn"
    | "abandonLaunch"
    | "markSpawned"
    | "markVerified"
    | "fail"
    | "recordProgress"
    | "complete"
    | "cancel"
    | "operatorRequired"
    | "listActiveByExecutor"
  >

const pullEvent = (iterator: AsyncIterator<CliEvent>) =>
  Effect.promise(() =>
    iterator.next().then(
      (next) => (next.done ? ("closed" as const) : next.value),
      () => "closed" as const,
    ),
  )

const diagnostic = (
  stalled: boolean,
  stallWindowMs: number,
  exit: Exit.Exit<CliExit, WorkspaceError>,
  turnFailed: string | null,
  cliName: string,
) => {
  if (stalled)
    return `${cliName}_stalled: no ${cliName} event for ${stallWindowMs}ms; the process group was terminated`
  const exitCode = Exit.isSuccess(exit) ? exit.value.exitCode : -1
  let detail = `${cliName}_failed: exit ${exitCode}`
  if (exitCode === 143 || exitCode === -15) detail += " (SIGTERM)"
  if (turnFailed !== null) detail += `; ${turnFailed}`
  if (Exit.isSuccess(exit) && exit.value.stderr !== "")
    detail += `; stderr: ${exit.value.stderr.slice(0, 500)}`
  return detail
}

type FirstToken =
  | {
      readonly outcome: "generating"
      readonly threadId: string
      readonly firstMessage: string
      readonly model?: string
    }
  | {
      readonly outcome: "refused"
      readonly reason: "provider_not_authenticated" | "no_first_token"
      readonly detail: string
    }
type Observation = {
  readonly result: FirstToken
  readonly terminationConfirmed: boolean
  readonly iterator: AsyncIterator<CliEvent>
  readonly exited: Fiber.Fiber<CliExit, WorkspaceError>
  readonly cancel: Effect.Effect<void, WorkspaceError>
}

const cliFailureDetail = (error: WorkspaceError) => `${error.operation}: ${String(error.cause)}`

const observeFirstToken = (process: CliRunProcess, timeoutMs: number, cliName: string) =>
  Effect.gen(function* () {
    const iterator = process.events[Symbol.asyncIterator]()
    const exited = yield* Effect.forkDetach(process.exited)
    let threadId: string | null = null
    let firstMessage: string | null = null
    let nativeModel: string | undefined
    const errors: string[] = []
    const streamed: Effect.Effect<FirstToken> = Effect.gen(function* () {
      const pull = pullEvent(iterator)
      for (;;) {
        const step = yield* pull
        if (step === "closed") {
          return {
            outcome: "refused" as const,
            reason: "no_first_token" as const,
            detail:
              firstMessage === null
                ? `${cliName} exited before producing model output`
                : `${cliName} produced model output but never announced a session id; the runner cannot custody it`,
          }
        }
        if (step.type === "thread.started") {
          threadId = step.threadId
          nativeModel = step.model
        } else if (step.type === "agent_message") {
          firstMessage ??= step.text
          if (threadId !== null)
            return {
              outcome: "generating" as const,
              threadId,
              firstMessage,
              ...(nativeModel === undefined ? {} : { model: nativeModel }),
            }
        } else if (step.type === "error" || step.type === "turn.failed") errors.push(step.message)
      }
    })
    const timedOut: Effect.Effect<FirstToken> = Effect.as(Effect.sleep(timeoutMs), {
      outcome: "refused" as const,
      reason: "no_first_token" as const,
      detail: `${cliName} produced no model output within ${timeoutMs}ms of spawn`,
    })
    const result = yield* Effect.race(streamed, timedOut)
    if (result.outcome === "generating") {
      return {
        result,
        terminationConfirmed: false,
        iterator,
        exited,
        cancel: process.cancel,
      } satisfies Observation
    }
    const grace = yield* Fiber.join(exited).pipe(Effect.result, Effect.timeoutOption(500))
    let terminalExit =
      Option.isSome(grace) && grace.value._tag === "Success" ? grace.value.success : null
    const cleanupDetails: string[] = []
    if (Option.isSome(grace) && grace.value._tag === "Failure")
      cleanupDetails.push(`exit observation failed: ${cliFailureDetail(grace.value.failure)}`)
    if (terminalExit === null) {
      const cancelled = yield* process.cancel.pipe(Effect.result)
      if (cancelled._tag === "Failure") {
        cleanupDetails.push(`first-token cleanup failed: ${cliFailureDetail(cancelled.failure)}`)
      } else {
        // A cancellation acknowledgement alone is not proof of native termination.
        // Refresh observation after cleanup, including an earlier inspection failure.
        const stopped = yield* process.exited.pipe(Effect.result, Effect.timeoutOption(500))
        if (Option.isSome(stopped) && stopped.value._tag === "Success")
          terminalExit = stopped.value.success
        else
          cleanupDetails.push(
            Option.isSome(stopped) && stopped.value._tag === "Failure"
              ? `termination observation failed: ${cliFailureDetail(stopped.value.failure)}`
              : "cleanup did not confirm native termination within 500ms",
          )
      }
    }
    const authFailed =
      codexFailureLooksUnauthenticated(errors) ||
      (terminalExit !== null && codexFailureLooksUnauthenticated([terminalExit.stderr]))
    const reason = authFailed ? ("provider_not_authenticated" as const) : result.reason
    let detail = result.detail
    if (authFailed) detail += `: the ${cliName} CLI reported an authentication failure`
    else {
      if (errors.length > 0) detail += `; last error: ${errors.at(-1)}`
      if (terminalExit !== null && terminalExit.stderr !== "")
        detail += `; stderr: ${terminalExit.stderr.slice(0, 300)}`
    }
    if (cleanupDetails.length > 0) detail += `; ${cleanupDetails.join("; ")}`
    if (terminalExit === null)
      detail += "; native termination unconfirmed; process custody retained"
    return {
      result: { outcome: "refused" as const, reason, detail },
      terminationConfirmed: terminalExit !== null,
      iterator,
      exited,
      cancel: process.cancel,
    } satisfies Observation
  })

export const makeAgentRunCliDispatcher = (dependencies: {
  /** Claude and Codex share durable process custody, verification, and recovery. */
  readonly executor: {
    readonly kind: "codex" | "claude"
    readonly sessionCustodyId: (nativeSessionId: string) => string
  }
  readonly cli: CliPort
  readonly store: AgentRunCliStore
  readonly worktrees: AgentRunWorktreesPort
  readonly signals: WorkSignalPort
  readonly ensureResource: Custody["ensureResource"]
  readonly ensureSession: Custody["ensureSession"]
  readonly refuse: (reason: RefusalReason, detail: string) => AgentRunRefusalError
  readonly verifyTimeoutMs: number
  readonly progressWindowMs: number
  readonly workerPrompt?: (run: AgentRunRecord) => Effect.Effect<string, WorkspaceError>
  readonly sandbox?: SandboxDispatchPort
}) => {
  const { cli, store, worktrees, signals, ensureResource, ensureSession, refuse } = dependencies
  const kind = dependencies.executor.kind
  const sessionCustodyId = dependencies.executor.sessionCustodyId
  const sandboxFailure = (cause: unknown) =>
    new WorkspaceError({
      operation: "native sandbox custody",
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  const finishSandbox = (
    run: AgentRunRecord,
    terminal: {
      state: "completed" | "operator_required"
      finalMessage: string | null
      diagnostic: string
    },
  ) => {
    const finish = dependencies.sandbox?.finishNative
    return finish === undefined
      ? Effect.fail(sandboxFailure("Native sandbox settlement unavailable"))
      : finish(run, terminal).pipe(Effect.mapError(sandboxFailure))
  }

  const recordModelEvidence = (run: AgentRunRecord, model: string | undefined, now: Date) =>
    model === undefined ||
    run.resolvedSelection == null ||
    store.recordResolvedSelection === undefined
      ? Effect.void
      : store.recordResolvedSelection({
          runId: run.runId,
          now,
          selection: { ...run.resolvedSelection, model, evidence: "runtime" },
        })

  const complete = (input: {
    readonly runId: string
    readonly iterator: AsyncIterator<CliEvent>
    readonly exited: Fiber.Fiber<CliExit, WorkspaceError>
    readonly cancel: Effect.Effect<void, WorkspaceError>
    readonly initialFinalMessage: string | null
    readonly stallWindowMs: number
    readonly sandboxRun?: AgentRunRecord
  }) =>
    Effect.gen(function* () {
      let finalMessage: string | null = input.initialFinalMessage
      let outputTokens: number | null = null
      let turnFailed: string | null = null
      let stalled = false
      for (;;) {
        const next = yield* pullEvent(input.iterator).pipe(
          Effect.timeoutOption(input.stallWindowMs),
        )
        if (Option.isNone(next)) {
          stalled = true
          break
        }
        if (next.value === "closed") break
        const event = next.value
        if (event.type === "agent_message") finalMessage = event.text
        else if (event.type === "turn.completed") outputTokens = event.outputTokens
        else if (event.type === "turn.failed") turnFailed = event.message
        else if (event.type === "error") turnFailed ??= event.message
      }
      if (stalled) yield* input.cancel.pipe(Effect.ignore)
      const exit: Exit.Exit<CliExit, WorkspaceError> = yield* Effect.exit(Fiber.join(input.exited))
      if (input.sandboxRun !== undefined) {
        yield* finishSandbox(input.sandboxRun, {
          state:
            !stalled &&
            turnFailed === null &&
            Exit.isSuccess(exit) &&
            exit.value.exitCode === 0 &&
            finalMessage !== null
              ? "completed"
              : "operator_required",
          finalMessage,
          diagnostic: diagnostic(stalled, input.stallWindowMs, exit, turnFailed, kind),
        })
        return
      }
      if (
        !stalled &&
        turnFailed === null &&
        Exit.isSuccess(exit) &&
        exit.value.exitCode === 0 &&
        finalMessage !== null
      ) {
        if (outputTokens !== null) {
          yield* store
            .recordProgress({ runId: input.runId, outputTokens, now: new Date() })
            .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
        }
        yield* store
          .complete({ runId: input.runId, now: new Date(), finalMessage })
          .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
        return
      }
      yield* store
        .operatorRequired({
          runId: input.runId,
          diagnostic: diagnostic(stalled, input.stallWindowMs, exit, turnFailed, kind),
          now: new Date(),
          finalMessage,
        })
        .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
    })

  const dispatch = (
    run: AgentRunRecord,
    route: AgentRunCliRoute,
    target: {
      readonly repositoryDirectory: string
      readonly resourceId: string
      readonly short: string
    },
    now: Date,
  ) =>
    Effect.suspend(() => {
      let claimed = false
      return Effect.gen(function* () {
        if (run.state === "spawning") {
          return yield* refuse(
            "run_conflict",
            "an identical dispatch is already spawning this run; retry after it settles",
          )
        }
        if (run.state === "accepted" || run.nativeSessionId === null) {
          yield* store.claimSpawn({ runId: run.runId, now })
          claimed = true
          const isolated = run.agent === "sandbox"
          const prepare = dependencies.sandbox?.prepareNative
          if (isolated && prepare === undefined)
            return yield* refuse("run_conflict", "Native sandbox preparation unavailable")
          const attachment = isolated
            ? yield* prepare!(run).pipe(Effect.mapError(sandboxFailure))
            : undefined
          const execution = attachment?.cli ?? cli
          if (!isolated)
            yield* createAgentRunWorktree(worktrees, {
              repository: target.repositoryDirectory,
              directory: run.directory,
              branch: `agent-run/${target.short}`,
              ...(run.baseRef == null ? {} : { base: `origin/${run.baseRef}` }),
            })
          const resourceId = yield* ensureResource({
            resourceId: target.resourceId,
            absolutePath: run.directory,
            kind: isolated ? "workspace" : "worktree",
            createdAt: run.createdAt,
          })
          const process = yield* execution
            .spawn({
              runId: run.runId,
              directory: run.directory,
              prompt:
                isolated || dependencies.workerPrompt === undefined
                  ? run.prompt
                  : yield* dependencies.workerPrompt(run),
              model: run.resolvedSelection?.model ?? route.modelID,
              ...(attachment === undefined
                ? {}
                : { sandboxBindingFile: attachment.sandboxBindingFile }),
              ...(run.resolvedSelection?.provider == null
                ? {}
                : { provider: run.resolvedSelection.provider }),
              ...(run.resolvedSelection?.thinking.effort === undefined
                ? {}
                : { effort: run.resolvedSelection.thinking.effort }),
            })
            .pipe(
              (effect) => (isolated ? Effect.uninterruptible(effect) : effect),
              Effect.tapError((error) =>
                error instanceof ExecutionSelectionError
                  ? store.abandonLaunch({ runId: run.runId, now: new Date() }).pipe(Effect.ignore)
                  : Effect.logError(`${kind} launch result uncertain; spawning custody retained`, {
                      runId: run.runId,
                      cause: error,
                    }),
              ),
              Effect.mapError((error) =>
                error instanceof ExecutionSelectionError
                  ? refuse(error.reason, error.detail)
                  : error,
              ),
            )
          const observed = yield* observeFirstToken(process, dependencies.verifyTimeoutMs, kind)
          if (observed.result.outcome === "refused") {
            if (isolated)
              yield* finishSandbox(run, {
                state: "operator_required",
                finalMessage: null,
                diagnostic: observed.result.detail,
              })
            else
              yield* (observed.terminationConfirmed ? store.fail : store.operatorRequired)({
                runId: run.runId,
                diagnostic: `${observed.result.reason}: ${observed.result.detail}`,
                now,
              }).pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
            return yield* refuse(observed.result.reason, observed.result.detail)
          }
          const threadId = observed.result.threadId
          yield* recordModelEvidence(run, observed.result.model, now)
          yield* ensureSession({
            nativeSessionId: threadId,
            resourceId,
            createdAt: run.createdAt,
            kind,
          })
          yield* store.markSpawned({
            runId: run.runId,
            resourceId,
            sessionId: sessionCustodyId(threadId),
            nativeSessionId: threadId,
            now,
          })
          yield* store.markVerified({ runId: run.runId, outputTokens: 1, now })
          if (execution.ownership === "transient-exec")
            yield* Effect.forkDetach(
              complete({
                runId: run.runId,
                iterator: observed.iterator,
                exited: observed.exited,
                cancel: observed.cancel,
                initialFinalMessage: observed.result.firstMessage,
                stallWindowMs: dependencies.progressWindowMs,
                ...(isolated ? { sandboxRun: run } : {}),
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(`${kind} inline completion failed`, { runId: run.runId, cause }),
                ),
              ),
            )
          yield* signals.wake("agent-run")
          return { nativeSessionId: threadId, outputTokens: 1, kind }
        }
        if (run.state === "verified" && run.nativeSessionId !== null) {
          return {
            nativeSessionId: run.nativeSessionId,
            outputTokens: run.lastOutputTokens,
            kind,
          }
        }
        return yield* refuse(
          "run_conflict",
          `a previous dispatch left this run ${run.state}; ${kind} processes cannot be re-observed`,
        )
      }).pipe(
        Effect.onError(() =>
          claimed && run.agent === "sandbox"
            ? finishSandbox(run, {
                state: "operator_required",
                finalMessage: null,
                diagnostic: "Native sandbox startup failed",
              }).pipe(Effect.ignore)
            : Effect.void,
        ),
      )
    })

  const recover = Effect.gen(function* () {
    if (cli.ownership === "resident-thread") return 0
    const runs = yield* store.listActiveByExecutor(kind, true)
    yield* cli.cleanup?.(runs.map((run) => run.runId)) ?? Effect.succeed(0)
    let attached = 0
    for (const run of runs) {
      if (run.agent === "sandbox") continue
      const attachment = yield* cli.attach({ runId: run.runId }).pipe(Effect.result)
      if (attachment._tag === "Failure") {
        yield* store.operatorRequired({
          runId: run.runId,
          diagnostic: `${kind}_recovery_failed: ${String(attachment.failure.cause)}`,
          now: new Date(),
        })
        continue
      }
      const process = attachment.success
      if (process === null) {
        yield* store.operatorRequired({
          runId: run.runId,
          diagnostic: `${kind}_recovery_failed: durable process custody is missing`,
          now: new Date(),
        })
        continue
      }
      let iterator = process.events[Symbol.asyncIterator]()
      let exited: Fiber.Fiber<CliExit, WorkspaceError>
      let initialFinalMessage: string | null = null
      if (run.state === "spawning") {
        const observed = yield* observeFirstToken(process, dependencies.verifyTimeoutMs, kind)
        if (observed.result.outcome === "refused") {
          yield* (observed.terminationConfirmed ? store.fail : store.operatorRequired)({
            runId: run.runId,
            diagnostic: `${kind}_recovery_failed: ${observed.result.detail}`,
            now: new Date(),
          }).pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
          continue
        }
        yield* recordModelEvidence(run, observed.result.model, new Date())
        const resourceId = yield* ensureResource({
          resourceId: `agent-run-resource-${run.runId.slice("agent-run-".length)}`,
          absolutePath: run.directory,
          kind: "worktree",
          createdAt: run.createdAt,
        })
        const sessionId = yield* ensureSession({
          nativeSessionId: observed.result.threadId,
          resourceId,
          createdAt: run.createdAt,
          kind,
        })
        yield* store.markSpawned({
          runId: run.runId,
          resourceId,
          sessionId,
          nativeSessionId: observed.result.threadId,
          now: new Date(),
        })
        yield* store.markVerified({ runId: run.runId, outputTokens: 1, now: new Date() })
        iterator = observed.iterator
        exited = observed.exited
        initialFinalMessage = observed.result.firstMessage
      } else {
        exited = yield* Effect.forkDetach(process.exited)
        if (run.state === "spawned") {
          yield* store.markVerified({
            runId: run.runId,
            outputTokens: Math.max(1, run.lastOutputTokens),
            now: new Date(),
          })
        }
      }
      yield* Effect.forkDetach(
        complete({
          runId: run.runId,
          iterator,
          exited,
          cancel: process.cancel,
          initialFinalMessage,
          stallWindowMs: dependencies.progressWindowMs,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`recovered ${kind} completion failed`, { runId: run.runId, cause }),
          ),
        ),
      )
      attached += 1
    }
    return attached
  })

  const cancellationUnconfirmed = (run: AgentRunRecord, now: Date, detail: string) =>
    Effect.gen(function* () {
      yield* store
        .operatorRequired({ runId: run.runId, diagnostic: `${kind}_cancel_failed: ${detail}`, now })
        .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
      return yield* refuse("run_conflict", `${detail}; process custody retained`)
    })

  const cancel = (run: AgentRunRecord, now: Date) =>
    Effect.gen(function* () {
      if (cli.ownership === "resident-thread") {
        const cancelled = yield* cli.cancelRun(run.runId).pipe(Effect.result)
        if (cancelled._tag === "Failure")
          return yield* cancellationUnconfirmed(
            run,
            now,
            `resident cancellation unconfirmed: ${cliFailureDetail(cancelled.failure)}`,
          )
        yield* store.cancel({ runId: run.runId, now })
        return
      }
      const attached = yield* cli.attach({ runId: run.runId }).pipe(Effect.result)
      if (attached._tag === "Failure")
        return yield* cancellationUnconfirmed(
          run,
          now,
          `${kind} process custody cannot be confirmed: ${cliFailureDetail(attached.failure)}`,
        )
      const attachment = attached.success
      if (attachment === null) {
        return yield* cancellationUnconfirmed(run, now, `${kind} process custody is missing`)
      }
      const cancelled = yield* attachment.cancel.pipe(Effect.result)
      if (cancelled._tag === "Failure")
        return yield* cancellationUnconfirmed(
          run,
          now,
          `${kind} cancellation unconfirmed: ${cliFailureDetail(cancelled.failure)}`,
        )
      yield* store.cancel({ runId: run.runId, now })
    })

  return { dispatch, recover, cancel }
}
