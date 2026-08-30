import { Context, Effect, Layer } from "effect"
import { WorkSignal } from "../work-signal"
import { AgentRunProvider } from "./agent-run-ingress"
import { AgentRunStore, type AgentRunRecord } from "./agent-run-store"

/**
 * Supervises verified agent runs so a caller never has to babysit a
 * dispatch. Each iteration observes at most one run:
 *
 * - token counters climbing → progress recorded, nothing else;
 * - no progress inside the configured window → the session is interrupted;
 * - an interrupted or failed idle session → re-prompted in place (same
 *   session, same worktree, bounded attempts), the documented manual stall
 *   recovery made mechanical;
 * - attempts exhausted → operator_required with the diagnostic trail;
 * - a successful idle session → the run completes; waking the
 *   agent-completion lane lets the completion source observe it promptly.
 *
 * The parent's wake remains the completion source and resume worker's job;
 * the watchdog only guarantees the child either finishes or surfaces.
 */
export type AgentRunWatchdogOptions = {
  readonly progressWindowMs: number
  readonly staleAfterMs: number
  readonly now: () => Date
}

export type AgentRunWatchdog = {
  readonly iteration: Effect.Effect<"worked" | "idle", never>
}

export const AgentRunWatchdog = Context.Service<AgentRunWatchdog>(
  "workflowd/kernel/AgentRunWatchdog",
)

const continuationPrompt = (run: AgentRunRecord) =>
  "You were interrupted after workflowd detected a stall in this session. " +
  "Continue the task from where you left off, working incrementally and " +
  "making your first file edit early. The original task follows.\n\n" +
  run.prompt

export const runAgentRunWatchdogIteration = (options: AgentRunWatchdogOptions) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    const provider = yield* AgentRunProvider
    const signals = yield* WorkSignal
    const now = options.now()
    const run = yield* store.nextWatchable({ now, staleAfterMs: options.staleAfterMs })
    if (run === null) return "idle" as const

    if (run.state !== "verified" || run.nativeSessionId === null) {
      yield* store.fail({
        runId: run.runId,
        diagnostic:
          `dispatch_incomplete: the run stayed in ${run.state} past the recovery ` +
          "window; the dispatching request likely died before verification",
        now,
      })
      return "worked" as const
    }

    const telemetry = yield* provider
      .sessionTelemetry({ sessionID: run.nativeSessionId })
      .pipe(Effect.option)
    if (telemetry._tag === "None") {
      // The provider is unreachable; leave the run untouched for the next tick.
      yield* store.touch({ runId: run.runId, now })
      return "idle" as const
    }
    if (telemetry.value === undefined) {
      yield* store.operatorRequired({
        runId: run.runId,
        diagnostic: `missing_session: ${run.nativeSessionId} no longer exists on the server`,
        now,
      })
      return "worked" as const
    }
    const observed = telemetry.value

    if (observed.idle) {
      if (observed.outcome === "succeeded" || observed.outcome === undefined) {
        yield* store.complete({ runId: run.runId, now })
        yield* signals.wake("agent-completion")
        return "worked" as const
      }
      if (run.attempt >= run.maxAttempts) {
        yield* store.operatorRequired({
          runId: run.runId,
          diagnostic:
            `attempts_exhausted: session ${run.nativeSessionId} ended ${observed.outcome} ` +
            `on attempt ${run.attempt} of ${run.maxAttempts}`,
          now,
        })
        return "worked" as const
      }
      yield* store.beginAttempt({
        runId: run.runId,
        attempt: run.attempt + 1,
        diagnostic:
          `resumed_after_${observed.outcome}: attempt ${run.attempt} ended ${observed.outcome}; ` +
          "the session was re-prompted in place",
        now,
      })
      yield* provider.promptSession({
        sessionID: run.nativeSessionId,
        directory: run.directory,
        agent: run.agent,
        model: { providerID: run.providerId, modelID: run.modelId },
        text: continuationPrompt(run),
      })
      return "worked" as const
    }

    if (observed.outputTokens > run.lastOutputTokens) {
      yield* store.recordProgress({ runId: run.runId, outputTokens: observed.outputTokens, now })
      return "idle" as const
    }
    const lastProgressAt = run.lastProgressAt ?? run.createdAt
    if (now.getTime() - lastProgressAt.getTime() > options.progressWindowMs) {
      // Interrupt only; the resulting idle+interrupted observation drives the
      // bounded re-prompt on a later tick, so recovery survives a crash here.
      yield* provider
        .abortSession({ sessionID: run.nativeSessionId, directory: run.directory })
        .pipe(Effect.ignore)
      yield* store.touch({ runId: run.runId, now })
      return "worked" as const
    }
    yield* store.touch({ runId: run.runId, now })
    return "idle" as const
  })

export const AgentRunWatchdogLive = (options: AgentRunWatchdogOptions) =>
  Layer.effect(
    AgentRunWatchdog,
    Effect.gen(function* () {
      const store = yield* AgentRunStore
      const provider = yield* AgentRunProvider
      const signals = yield* WorkSignal
      return {
        iteration: runAgentRunWatchdogIteration(options).pipe(
          Effect.provideService(AgentRunStore, store),
          Effect.provideService(AgentRunProvider, provider),
          Effect.provideService(WorkSignal, signals),
          Effect.catchCause((cause) =>
            Effect.logError("Agent-run watchdog iteration failed", cause).pipe(
              Effect.as("idle" as const),
            ),
          ),
        ),
      }
    }),
  )
