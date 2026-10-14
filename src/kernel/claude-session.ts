import {
  withCredentialAdmission,
  hostWorkerIdentity,
  startAgentHost,
  inspectAgentHost,
  readAgentHostOutput,
} from "../agent-host/client"
import { createHash } from "node:crypto"
import { refreshAgentGitGuard } from "../agent-git/guard"
import { agentGitEnvironment, type AgentGitConfig } from "../agent-git/config"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
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

/** Extracts the owning host from a claude custody endpoint identity; null
 * for anything that is not a well-formed claude-cli:// identity. */
export const claudeHostFromEndpointIdentity = (identity: string): string | null => {
  const match = /^claude-cli:\/\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(identity)
  return match === null ? null : match[1]!
}

/** Claude Code's project-directory encoding: every path separator (and any
 * other non [A-Za-z0-9-] character) becomes a dash. */
export const encodeClaudeProjectDir = (directory: string) =>
  directory.replace(/[^A-Za-z0-9-]/g, "-")

export type ClaudeCliPort = {
  readonly hasDelivery?: (deliveryId: string) => Effect.Effect<boolean, WorkspaceError>
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
    readonly deliveryId?: string
  }) => Effect.Effect<string, WorkspaceError>
}

export const ClaudeCli = Context.Service<ClaudeCliPort>("workflowd/kernel/ClaudeCli")

const MAX_CLAUDE_STDOUT_BYTES = 262_144
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export const makeClaudeCli = (options: {
  readonly git?: AgentGitConfig | undefined
  readonly binary: string
  readonly identity?: {
    nativeRun: (
      sessionId: string,
      directory: string,
    ) => Effect.Effect<string | null, WorkspaceError>
    environment: (runId: string) => Readonly<Record<string, string>>
    register: (runId: string, pid: number) => void
  }
  readonly home?: string
  readonly credentialSocket?: string | undefined
}): ClaudeCliPort =>
  options.credentialSocket === undefined
    ? {
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
          // Argument-vector spawn, and the prompt rides stdin: untrusted session
          // content never appears in argv or a shell string.
          withCredentialAdmission(
            options.credentialSocket,
            "claude",
            refreshAgentGitGuard(input.directory, options.git)
              .pipe(
                Effect.andThen(
                  runWorkspaceCommandBytes(
                    "wake claude session",
                    [
                      options.binary,
                      "--setting-sources",
                      "user",
                      "-p",
                      "--resume",
                      input.nativeSessionId,
                      "--output-format",
                      "json",
                    ],
                    {
                      env: agentGitEnvironment(options.git),
                      cwd: input.directory,
                      stdin: input.prompt,
                      maxStdoutBytes: MAX_CLAUDE_STDOUT_BYTES,
                    },
                  ),
                ),
              )
              .pipe(
                Effect.timeoutOrElse({
                  duration: input.timeoutMs,
                  orElse: () =>
                    Effect.fail(
                      new WorkspaceError({
                        operation: "wake claude session",
                        cause: new Error(
                          `claude resume did not finish within ${input.timeoutMs}ms`,
                        ),
                      }),
                    ),
                }),
                Effect.map((output) => new TextDecoder().decode(output.stdout)),
              ),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof WorkspaceError
                ? error
                : new WorkspaceError({ operation: "credential admission", cause: error }),
            ),
          ),
      }
    : hostClaudeCli(options.credentialSocket, options.identity)

function hostClaudeCli(
  socket: string,
  identity?: Parameters<typeof makeClaudeCli>[0]["identity"],
): ClaudeCliPort {
  const hostId = (deliveryId: string) =>
    `claude-turn-${createHash("sha256").update(deliveryId).digest("hex")}`
  const failure = (cause: unknown) =>
    new WorkspaceError({
      operation: "wake claude session",
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  return {
    hasDelivery: (deliveryId) =>
      Effect.tryPromise({
        try: async () => (await inspectAgentHost(socket, hostId(deliveryId))) !== null,
        catch: failure,
      }),
    sessionExists: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!SESSION_ID_PATTERN.test(input.nativeSessionId)) return false
          const process = await startAgentHost(socket, {
            profile: "claude-session",
            runId: `session-${crypto.randomUUID()}`,
            directory: input.directory,
            nativeSessionId: input.nativeSessionId,
            prompt: "",
            model: null,
          })
          return Schema.decodeUnknownSync(Schema.Boolean)(
            JSON.parse(await readAgentHostOutput(socket, process)),
          )
        },
        catch: failure,
      }),
    resume: (input) =>
      Effect.tryPromise({
        try: async (signal) => {
          const runId = identity
            ? await Effect.runPromise(identity.nativeRun(input.nativeSessionId, input.directory))
            : null
          const process = await startAgentHost(socket, {
            profile: "claude-resume",
            ...(runId && identity
              ? { worker: hostWorkerIdentity(identity.environment(runId)) }
              : {}),
            runId: hostId(input.deliveryId ?? `resume-${crypto.randomUUID()}`),
            directory: input.directory,
            nativeSessionId: input.nativeSessionId,
            prompt: input.prompt,
            model: null,
            timeoutMs: input.timeoutMs,
          })
          if (runId && process.pid > 0) identity?.register(runId, process.pid)
          return readAgentHostOutput(socket, process, MAX_CLAUDE_STDOUT_BYTES, signal)
        },
        catch: failure,
      }),
  }
}
