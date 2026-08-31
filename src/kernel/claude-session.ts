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
 *
 * Sessions on other hosts are reached over SSH to a configured destination.
 * The prompt always rides stdin, never a shell string; the session id and
 * directory are validated to shell-inert character sets before they may
 * appear in a remote command.
 */
export const CLAUDE_PROVIDER_ID = "claude-cli"
export const CLAUDE_ENDPOINT_ALIAS = "local-cli"

export const claudeSessionCustodyId = (nativeSessionId: string) =>
  `claude-session-${nativeSessionId}`

export const claudeEndpointIdentity = (host: string) => `claude-cli://${host}`

export const claudeHostFromEndpointIdentity = (identity: string): string | null => {
  const match = /^claude-cli:\/\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(identity)
  return match === null ? null : match[1]!
}

/** Claude Code's project-directory encoding: every path separator (and any
 * other non [A-Za-z0-9-] character) becomes a dash. */
export const encodeClaudeProjectDir = (directory: string) =>
  directory.replace(/[^A-Za-z0-9-]/g, "-")

export type ClaudeCliPort = {
  /** True when the session transcript exists for this working directory on
   * the named host. */
  readonly sessionExists: (input: {
    readonly nativeSessionId: string
    readonly directory: string
    readonly host: string
  }) => Effect.Effect<boolean, WorkspaceError>
  /** Continues the session with one prompt and returns the answer text. */
  readonly resume: (input: {
    readonly nativeSessionId: string
    readonly directory: string
    readonly host: string
    readonly prompt: string
    readonly timeoutMs: number
  }) => Effect.Effect<string, WorkspaceError>
  /** Hosts this port can deliver to (the daemon host plus configured
   * remotes); dispatch refuses parents on any other host up front. */
  readonly hosts: ReadonlyArray<string>
}

export const ClaudeCli = Context.Service<ClaudeCliPort>("workflowd/kernel/ClaudeCli")

const MAX_CLAUDE_STDOUT_BYTES = 262_144
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/
/** Absolute, no spaces/quotes/metacharacters: inert inside single quotes and
 * safe to embed in a remote command line. */
const REMOTE_DIRECTORY_PATTERN = /^\/[A-Za-z0-9._/-]+$/
const SSH_DESTINATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/

export type ClaudeCliHost = { readonly host: string; readonly destination: string }

const failure = (operation: string, message: string) =>
  new WorkspaceError({ operation, cause: new Error(message) })

export const makeClaudeCli = (options: {
  readonly binary: string
  readonly localHost: string
  readonly remoteHosts?: ReadonlyArray<ClaudeCliHost>
  readonly home?: string
}): ClaudeCliPort => {
  const remote = new Map(
    (options.remoteHosts ?? []).map((entry) => [entry.host, entry.destination]),
  )
  const hosts = [options.localHost, ...remote.keys()]

  const sshCommand = (destination: string, script: string) => [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    destination,
    script,
  ]

  const remoteScript = (input: { nativeSessionId: string; directory: string }, probe: boolean) => {
    const transcript = `$HOME/.claude/projects/${encodeClaudeProjectDir(input.directory)}/${input.nativeSessionId}.jsonl`
    return probe
      ? `test -f "${transcript}"`
      : `cd '${input.directory}' && PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" ` +
          `claude -p --resume '${input.nativeSessionId}' --output-format json`
  }

  const checkedRemote = (
    operation: string,
    input: { nativeSessionId: string; directory: string; host: string },
  ): Effect.Effect<string, WorkspaceError> => {
    const destination = remote.get(input.host)
    if (destination === undefined) {
      return Effect.fail(failure(operation, `no delivery route to claude host ${input.host}`))
    }
    if (!SSH_DESTINATION_PATTERN.test(destination)) {
      return Effect.fail(failure(operation, "configured ssh destination is not a plain user@host"))
    }
    if (!REMOTE_DIRECTORY_PATTERN.test(input.directory)) {
      return Effect.fail(failure(operation, "remote directory must be a plain absolute path"))
    }
    return Effect.succeed(destination)
  }

  const sessionExists: ClaudeCliPort["sessionExists"] = (input) => {
    if (!SESSION_ID_PATTERN.test(input.nativeSessionId)) return Effect.succeed(false)
    if (input.host === options.localHost) {
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
    }
    return checkedRemote("probe remote claude session", input).pipe(
      Effect.flatMap((destination) =>
        runWorkspaceCommandBytes(
          "probe remote claude session",
          sshCommand(destination, remoteScript(input, true)),
          { maxStdoutBytes: 4_096 },
        ).pipe(
          Effect.map(() => true),
          // A nonzero exit is "not there" (or unreachable) — the caller's
          // refusal names both possibilities.
          Effect.catch(() => Effect.succeed(false)),
        ),
      ),
    )
  }

  const resume: ClaudeCliPort["resume"] = (input) =>
    Effect.gen(function* () {
      if (!SESSION_ID_PATTERN.test(input.nativeSessionId)) {
        return yield* Effect.fail(
          failure("wake claude session", "session id is not a plain identifier"),
        )
      }
      // The prompt always rides stdin so no session content ever appears in
      // argv or a remote shell string.
      const command =
        input.host === options.localHost
          ? [options.binary, "-p", "--resume", input.nativeSessionId, "--output-format", "json"]
          : sshCommand(
              yield* checkedRemote("wake claude session", input),
              remoteScript(input, false),
            )
      const output = yield* runWorkspaceCommandBytes("wake claude session", command, {
        ...(input.host === options.localHost ? { cwd: input.directory } : {}),
        stdin: input.prompt,
        maxStdoutBytes: MAX_CLAUDE_STDOUT_BYTES,
      }).pipe(
        Effect.timeoutOrElse({
          duration: input.timeoutMs,
          orElse: () =>
            Effect.fail(
              failure(
                "wake claude session",
                `claude resume did not finish within ${input.timeoutMs}ms`,
              ),
            ),
        }),
      )
      return new TextDecoder().decode(output.stdout)
    })

  return { sessionExists, resume, hosts }
}
