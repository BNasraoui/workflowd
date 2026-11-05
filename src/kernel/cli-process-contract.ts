import type { CredentialAdmissionReason } from "../agent-host/protocol"
import type { Effect } from "effect"
import type { ExecutionSelectionError } from "../execution-selection"
import type { WorkspaceError } from "../workspace/errors"
export type CliEvent =
  | { readonly type: "thread.started"; readonly threadId: string; readonly model?: string }
  | { readonly type: "turn.started" }
  | { readonly type: "agent_message"; readonly text: string }
  | { readonly type: "turn.completed"; readonly outputTokens: number | null }
  | { readonly type: "turn.failed"; readonly message: string; readonly codexErrorInfo?: unknown }
  | { readonly type: "error"; readonly message: string; readonly codexErrorInfo?: unknown }
  | { readonly type: "other" }

export type CliPreflightError = {
  readonly kind:
    "cli_unusable" | "not_authenticated" | "systemd_unavailable" | CredentialAdmissionReason
  readonly detail: string
}

export type CliExit = { readonly exitCode: number; readonly stderr: string }

const OBSERVATION_UNAVAILABLE = "ObservationUnavailableError"

/**
 * A manager query that got no answer: a killed or timed-out `systemctl`, or a
 * manager it could not reach. It says nothing about the process, so its
 * observer may re-attach.
 */
export const observationUnavailableError = (message: string, options?: ErrorOptions) =>
  Object.assign(new Error(message, options), { name: OBSERVATION_UNAVAILABLE })

const HOST_UNREACHABLE: CredentialAdmissionReason = "credential_host_unreachable_or_timed_out"

/**
 * Whether an observation failure may be retried: an unanswered manager query, or
 * an agent host socket that was unreachable or timed out. Every other failure is
 * evidence (custody or identity changed, a record failed to decode).
 */
export const observationUnavailable = (failure: unknown): boolean => {
  let current = failure
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (current instanceof Error && current.name === OBSERVATION_UNAVAILABLE) return true
    if ("reason" in current && current.reason === HOST_UNREACHABLE) return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
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
