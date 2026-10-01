import type { Effect } from "effect"
import type { ExecutionSelectionError } from "../execution-selection"
import type { WorkspaceError } from "../workspace/errors"
export type CliEvent =
  | { readonly type: "thread.started"; readonly threadId: string; readonly model?: string }
  | { readonly type: "turn.started" }
  | { readonly type: "agent_message"; readonly text: string }
  | { readonly type: "turn.completed"; readonly outputTokens: number | null }
  | { readonly type: "turn.failed"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "other" }

export type CliPreflightError = {
  readonly kind: "cli_unusable" | "not_authenticated" | "systemd_unavailable"
  readonly detail: string
}

export type CliExit = { readonly exitCode: number; readonly stderr: string }

export type CliRunProcess = {
  readonly executionId: string
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
