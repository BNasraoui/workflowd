import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect } from "effect"
import { runWorkspaceCommandBytes } from "../workspace/command"
import { WorkspaceError } from "../workspace/errors"

/**
 * Claude Code sessions live as JSONL transcripts under
 * `~/.claude/projects/<encoded working directory>/<session id>.jsonl`, and
 * the `claude` CLI is their only programmatic surface: `claude -p --resume
 * <id>` continues the conversation and prints the answer. That CLI call is
 * the Claude analog of OpenCode's promptAsync, and — deliberately — the
 * only way workflowd ever drives a Claude model.
 */
export const CLAUDE_PROVIDER_ID = "claude-cli"
export const CLAUDE_ENDPOINT_ALIAS = "local-cli"

export const claudeSessionCustodyId = (nativeSessionId: string) =>
  `claude-session-${nativeSessionId}`

export const claudeEndpointIdentity = (owningHostId: string) => `claude-cli://${owningHostId}`

/** Claude Code's project-directory encoding: every path separator (and any
 * other non [A-Za-z0-9-] character) becomes a dash. */
export const encodeClaudeProjectDir = (directory: string) =>
  directory.replace(/[^A-Za-z0-9-]/g, "-")

export type ClaudeCliPort = {
  /** True when the session transcript exists for this working directory. */
  readonly sessionExists: (input: {
    readonly nativeSessionId: string
    readonly directory: string
  }) => Effect.Effect<boolean, WorkspaceError>
  /** Continues the session with one prompt and returns the answer text. */
  readonly resume: (input: {
    readonly nativeSessionId: string
    readonly directory: string
    readonly prompt: string
    readonly timeoutMs: number
  }) => Effect.Effect<string, WorkspaceError>
}

export const ClaudeCli = Context.Service<ClaudeCliPort>("workflowd/kernel/ClaudeCli")

const MAX_CLAUDE_STDOUT_BYTES = 262_144
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export const makeClaudeCli = (options: {
  readonly binary: string
  readonly home?: string
}): ClaudeCliPort => ({
  sessionExists: (input) => {
    if (!SESSION_ID_PATTERN.test(input.nativeSessionId)) return Effect.succeed(false)
    const transcript = join(
      options.home ?? homedir(),
      ".claude",
      "projects",
      encodeClaudeProjectDir(input.directory),
      `${input.nativeSessionId}.jsonl`,
    )
    return Effect.promise(() =>
      stat(transcript).then(
        (info) => info.isFile(),
        () => false,
      ),
    )
  },
  resume: (input) =>
    // Argument-vector spawn only: the prompt is untrusted text and never
    // passes through a shell string.
    runWorkspaceCommandBytes(
      "wake claude session",
      [
        options.binary,
        "-p",
        "--resume",
        input.nativeSessionId,
        "--output-format",
        "json",
        input.prompt,
      ],
      { cwd: input.directory, maxStdoutBytes: MAX_CLAUDE_STDOUT_BYTES },
    ).pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () =>
          Effect.fail(
            new WorkspaceError({
              operation: "wake claude session",
              cause: new Error(`claude resume did not finish within ${input.timeoutMs}ms`),
            }),
          ),
      }),
      Effect.map((output) => new TextDecoder().decode(output.stdout)),
    ),
})
