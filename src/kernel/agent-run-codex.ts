import { Effect, Exit, Fiber, Option } from "effect"
import type { AgentRunCodexRoute } from "../agent-run-contract"
import type { WorkspaceError } from "../workspace/errors"
import type { WorkSignalPort } from "../work-signal"
import type { AgentRunRefusalError } from "./agent-run-ingress"
import type { makeAgentRunCustody } from "./agent-run-custody"
import {
  codexFailureLooksUnauthenticated,
  codexSessionCustodyId,
  type CodexCliPort,
  type CodexExecEvent,
  type CodexExit,
  type CodexRunProcess,
} from "./codex-session"
import type { AgentRunRecord, AgentRunStorePort } from "./agent-run-store"
import type { AgentRunWorktreesPort } from "./agent-run-worktrees"

type RefusalReason = "provider_not_authenticated" | "no_first_token" | "run_conflict"
type Custody = ReturnType<typeof makeAgentRunCustody>
export type AgentRunCodexStore = Pick<
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
  | "listActiveByProvider"
>

const pullEvent = (iterator: AsyncIterator<CodexExecEvent>) =>
  Effect.promise(() =>
    iterator.next().then(
      (next) => (next.done ? ("closed" as const) : next.value),
      () => "closed" as const,
    ),
  )

const diagnostic = (
  stalled: boolean,
  stallWindowMs: number,
  exit: Exit.Exit<CodexExit, WorkspaceError>,
  turnFailed: string | null,
) => {
  if (stalled)
    return `codex_stalled: no codex event for ${stallWindowMs}ms; the process group was terminated`
  const exitCode = Exit.isSuccess(exit) ? exit.value.exitCode : -1
  let detail = `codex_failed: exit ${exitCode}`
  if (turnFailed !== null) detail += `; ${turnFailed}`
  if (Exit.isSuccess(exit) && exit.value.stderr !== "")
    detail += `; stderr: ${exit.value.stderr.slice(0, 500)}`
  return detail
}

type FirstToken =
  | { readonly outcome: "generating"; readonly threadId: string; readonly firstMessage: string }
  | {
      readonly outcome: "refused"
      readonly reason: "provider_not_authenticated" | "no_first_token"
      readonly detail: string
    }
type Observation = {
  readonly result: FirstToken
  readonly iterator: AsyncIterator<CodexExecEvent>
  readonly exited: Fiber.Fiber<CodexExit, WorkspaceError>
  readonly cancel: Effect.Effect<void, WorkspaceError>
}

const observeFirstToken = (process: CodexRunProcess, timeoutMs: number) =>
  Effect.gen(function* () {
    const iterator = process.events[Symbol.asyncIterator]()
    const exited = yield* Effect.forkDetach(process.exited)
    let threadId: string | null = null
    let firstMessage: string | null = null
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
                ? "codex exited before producing model output"
                : "codex produced model output but never announced a thread id; the runner cannot custody it",
          }
        }
        if (step.type === "thread.started") threadId = step.threadId
        else if (step.type === "agent_message") {
          firstMessage ??= step.text
          if (threadId !== null) return { outcome: "generating" as const, threadId, firstMessage }
        } else if (step.type === "error" || step.type === "turn.failed") errors.push(step.message)
      }
    })
    const timedOut: Effect.Effect<FirstToken> = Effect.as(Effect.sleep(timeoutMs), {
      outcome: "refused" as const,
      reason: "no_first_token" as const,
      detail: `codex produced no model output within ${timeoutMs}ms of spawn`,
    })
    const result = yield* Effect.race(streamed, timedOut)
    if (result.outcome === "generating") {
      return { result, iterator, exited, cancel: process.cancel } satisfies Observation
    }
    const graceExit: CodexExit | null = yield* Effect.race(
      Fiber.join(exited),
      Effect.as(Effect.sleep(500), null),
    )
    if (graceExit === null) yield* process.cancel.pipe(Effect.ignore)
    const authFailed =
      codexFailureLooksUnauthenticated(errors) ||
      (graceExit !== null && codexFailureLooksUnauthenticated([graceExit.stderr]))
    const reason = authFailed ? ("provider_not_authenticated" as const) : result.reason
    let detail = result.detail
    if (authFailed) detail += ": the codex CLI reported an authentication failure"
    else {
      if (errors.length > 0) detail += `; last error: ${errors.at(-1)}`
      if (graceExit !== null && graceExit.stderr !== "")
        detail += `; stderr: ${graceExit.stderr.slice(0, 300)}`
    }
    return {
      result: { outcome: "refused" as const, reason, detail },
      iterator,
      exited,
      cancel: process.cancel,
    } satisfies Observation
  })

export const makeAgentRunCodexDispatcher = (dependencies: {
  readonly codex: CodexCliPort
  readonly store: AgentRunCodexStore
  readonly worktrees: AgentRunWorktreesPort
  readonly signals: WorkSignalPort
  readonly ensureResource: Custody["ensureResource"]
  readonly ensureSession: Custody["ensureSession"]
  readonly refuse: (reason: RefusalReason, detail: string) => AgentRunRefusalError
  readonly verifyTimeoutMs: number
  readonly progressWindowMs: number
}) => {
  const { codex, store, worktrees, signals, ensureResource, ensureSession, refuse } = dependencies

  const complete = (input: {
    readonly runId: string
    readonly iterator: AsyncIterator<CodexExecEvent>
    readonly exited: Fiber.Fiber<CodexExit, WorkspaceError>
    readonly cancel: Effect.Effect<void, WorkspaceError>
    readonly initialFinalMessage: string | null
    readonly stallWindowMs: number
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
      const exit: Exit.Exit<CodexExit, WorkspaceError> = yield* Effect.exit(
        Fiber.join(input.exited),
      )
      if (!stalled && Exit.isSuccess(exit) && exit.value.exitCode === 0 && finalMessage !== null) {
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
      yield* store
        .operatorRequired({
          runId: input.runId,
          diagnostic: diagnostic(stalled, input.stallWindowMs, exit, turnFailed),
          now: new Date(),
        })
        .pipe(Effect.catchTag("AgentRunStoreConflictError", () => Effect.void))
    })

  const dispatch = (
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
        const process = yield* codex
          .spawn({
            runId: run.runId,
            directory: run.directory,
            prompt: run.prompt,
            model: route.modelID,
          })
          .pipe(
            Effect.tapError((cause) =>
              store.abandonLaunch({ runId: run.runId, now: new Date() }).pipe(
                Effect.tap(() =>
                  Effect.logError("codex launch failed; incomplete run claim removed", {
                    runId: run.runId,
                    cause,
                  }),
                ),
                Effect.ignore,
              ),
            ),
          )
        const observed = yield* observeFirstToken(process, dependencies.verifyTimeoutMs)
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
        yield* store.markVerified({ runId: run.runId, outputTokens: 1, now })
        yield* Effect.forkDetach(
          complete({
            runId: run.runId,
            iterator: observed.iterator,
            exited: observed.exited,
            cancel: observed.cancel,
            initialFinalMessage: observed.result.firstMessage,
            stallWindowMs: dependencies.progressWindowMs,
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

  const recover = Effect.gen(function* () {
    const runs = yield* store.listActiveByProvider("codex-cli")
    yield* codex.cleanup?.(runs.map((run) => run.runId)) ?? Effect.succeed(0)
    let attached = 0
    for (const run of runs) {
      const attachment = yield* codex.attach({ runId: run.runId }).pipe(Effect.result)
      if (attachment._tag === "Failure") {
        yield* store.operatorRequired({
          runId: run.runId,
          diagnostic: `codex_recovery_failed: ${String(attachment.failure.cause)}`,
          now: new Date(),
        })
        continue
      }
      const process = attachment.success
      if (process === null) {
        yield* store.operatorRequired({
          runId: run.runId,
          diagnostic: "codex_recovery_failed: durable process custody is missing",
          now: new Date(),
        })
        continue
      }
      let iterator = process.events[Symbol.asyncIterator]()
      let exited = yield* Effect.forkDetach(process.exited)
      let initialFinalMessage: string | null = null
      if (run.state === "spawning") {
        const observed = yield* observeFirstToken(process, dependencies.verifyTimeoutMs)
        if (observed.result.outcome === "refused") {
          yield* store.fail({
            runId: run.runId,
            diagnostic: `codex_recovery_failed: ${observed.result.detail}`,
            now: new Date(),
          })
          continue
        }
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
          kind: "codex",
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
      } else if (run.state === "spawned") {
        yield* store.markVerified({
          runId: run.runId,
          outputTokens: Math.max(1, run.lastOutputTokens),
          now: new Date(),
        })
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
            Effect.logError("recovered codex completion failed", { runId: run.runId, cause }),
          ),
        ),
      )
      attached += 1
    }
    return attached
  })

  const cancel = (run: AgentRunRecord, now: Date) =>
    Effect.gen(function* () {
      const attachment = yield* codex.attach({ runId: run.runId })
      if (attachment === null) {
        yield* store.operatorRequired({
          runId: run.runId,
          diagnostic: "codex_cancel_failed: durable process custody is missing",
          now,
        })
        return yield* refuse("run_conflict", "codex process custody is missing")
      }
      yield* attachment.cancel.pipe(
        Effect.tapError((cause) =>
          store
            .operatorRequired({
              runId: run.runId,
              diagnostic: `codex_cancel_failed: ${String(cause.cause)}`,
              now,
            })
            .pipe(Effect.ignore),
        ),
      )
      yield* store.cancel({ runId: run.runId, now })
    })

  return { dispatch, recover, cancel }
}
