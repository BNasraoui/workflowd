import type { Effect } from "effect"
import type { WorkspaceError } from "../workspace/errors"
import type { CodexExecEvent } from "./codex-session"

export type CodexPreflightError = {
  readonly kind: "cli_unusable" | "not_authenticated" | "systemd_unavailable"
  readonly detail: string
}

export type CodexExit = { readonly exitCode: number; readonly stderr: string }

export type CodexRunProcess = {
  readonly executionId: string
  readonly events: AsyncIterable<CodexExecEvent>
  readonly exited: Effect.Effect<CodexExit, WorkspaceError>
  readonly cancel: Effect.Effect<void, WorkspaceError>
}

export type CodexSpawnInput = {
  /** Resident mode registers this process root for run-bound peer auth. */
  readonly onSpawn?: (pid: number) => void
  /** Resident-only worker identity environment. One-shot custody ignores it. */
  readonly env?: Readonly<Record<string, string>>
  readonly runId: string
  readonly directory: string
  readonly prompt: string
  readonly model: string | null
}

type CodexCliCommon = {
  readonly preflight: Effect.Effect<void, CodexPreflightError>
  readonly spawn: (input: CodexSpawnInput) => Effect.Effect<CodexRunProcess, WorkspaceError>
}

export type CodexCliPort = CodexCliCommon &
  (
    | {
        readonly ownership: "transient-exec"
        readonly attach: (input: {
          readonly runId: string
        }) => Effect.Effect<CodexRunProcess | null, WorkspaceError>
        readonly cleanup?: (
          protectedRunIds: ReadonlyArray<string>,
        ) => Effect.Effect<number, WorkspaceError>
      }
    | {
        readonly ownership: "resident-thread"
        readonly cancelRun: (runId: string) => Effect.Effect<void, WorkspaceError>
      }
  )
