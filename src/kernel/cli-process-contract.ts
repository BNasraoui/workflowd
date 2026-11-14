import type { CredentialAdmissionReason } from "../agent-host/protocol"
import { OBSERVATION_EVIDENCE } from "../errors"
import type { Effect } from "effect"
import type { ExecutionSelectionError } from "../execution-selection"
import type { WorkspaceError } from "../workspace/errors"
export type CliEvent =
  | { readonly type: "thread.started"; readonly threadId: string; readonly model?: string }
  | { readonly type: "turn.started" }
  | { readonly type: "agent_message"; readonly text: string }
  | { readonly type: "provider.response"; readonly model: string; readonly outputTokens: number }
  | { readonly type: "turn.completed"; readonly outputTokens: number | null }
  | { readonly type: "turn.failed"; readonly message: string; readonly codexErrorInfo?: unknown }
  | { readonly type: "error"; readonly message: string; readonly codexErrorInfo?: unknown }
  | { readonly type: "other" }

export type CliPreflightError = {
  readonly kind:
    "cli_unusable" | "not_authenticated" | "systemd_unavailable" | CredentialAdmissionReason
  readonly detail: string
}

export type CliExit = { readonly exitCode: number; readonly stderr: string; readonly paused?: true }

/**
 * Whether an observation failure may be retried. Only known evidence is final;
 * any other manager, bus or host failure says nothing about the process.
 */
export const observationUnavailable = (failure: unknown): boolean => {
  let current = failure
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (current instanceof Error && current.name === OBSERVATION_EVIDENCE) return false
    current = (current as { readonly cause?: unknown }).cause
  }
  return true
}

/** One launch of a run. A re-attach that finds another launch has lost custody. */
export type CliLaunch = { readonly launchId: string; readonly invocationId: string | null }

export const sameLaunch = (expected: CliLaunch | undefined, actual: CliLaunch | undefined) =>
  expected === undefined ||
  (actual !== undefined &&
    actual.launchId === expected.launchId &&
    (expected.invocationId === null ||
      actual.invocationId === null ||
      actual.invocationId === expected.invocationId))

export type CliRunProcess = {
  readonly executionId: string
  readonly launch?: CliLaunch
  readonly events: AsyncIterable<CliEvent>
  readonly exited: Effect.Effect<CliExit, WorkspaceError>
  readonly cancel: Effect.Effect<void, WorkspaceError>
  /** Explicit controller selection; never called in response to agent hook/transcript data. */
  readonly finish?: (revision: number) => Effect.Effect<void, WorkspaceError>
  readonly pause?: Effect.Effect<void, WorkspaceError>
}

export type CliSpawnInput = {
  /** Resident mode registers this process root for run-bound peer auth. */
  readonly onSpawn?: (pid: number) => void
  /** Resident-only worker identity environment. One-shot custody ignores it. */
  readonly env?: Readonly<Record<string, string>>
  readonly runId: string
  readonly directory: string
  readonly prompt: string
  readonly model: string | null
  readonly provider?: string | null
  readonly effort?: string
  readonly sandboxBindingFile?: string
}

type CliCommon = {
  readonly preflight: Effect.Effect<void, CliPreflightError>
  readonly spawn: (
    input: CliSpawnInput,
  ) => Effect.Effect<CliRunProcess, WorkspaceError | ExecutionSelectionError>
}

export type CliPort = CliCommon &
  (
    | {
        readonly ownership: "transient-exec"
        readonly executionId?: (runId: string) => string
        readonly attach: (input: {
          readonly runId: string
        }) => Effect.Effect<CliRunProcess | null, WorkspaceError>
        readonly cleanup?: (
          protectedRunIds: ReadonlyArray<string>,
        ) => Effect.Effect<number, WorkspaceError>
      }
    | {
        readonly ownership: "resident-thread"
        readonly cancelRun: (runId: string) => Effect.Effect<void, WorkspaceError>
      }
  )
