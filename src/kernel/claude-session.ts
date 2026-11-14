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
import { mkdtemp, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
import { WorkspaceError } from "../workspace/errors"
import { claudeInteractiveArguments, runClaudeInteractiveTurn } from "./claude-interactive"

/**
 * Claude Code sessions live as JSONL transcripts under
 * `~/.claude/projects/<encoded working directory>/<session id>.jsonl`, and
 * this shared-host resume adapter continues them with a normal interactive
 * `claude --resume <id>` turn in a private PTY. Actions-native runs use the
 * separately supervised PTY path in sandbox/native-execution.ts.
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

/** Prepare a resumed interactive turn: Git guard, argv and environment, no launch. */
export const prepareClaudeResume = Effect.fn("ClaudeCli.prepareResume")(function* (
  binary: string,
  input: Parameters<ClaudeCliPort["resume"]>[0],
  git?: AgentGitConfig,
  home?: string,
) {
  yield* refreshAgentGitGuard(input.directory, git)
  const session = { id: input.nativeSessionId, resume: true }
  const args = yield* Effect.tryPromise({
    try: () =>
      claudeInteractiveArguments({ binary, directory: input.directory, model: null }, session),
    catch: (cause) => resumeFailure(cause),
  })
  // A selected transcript home is also the resumed process's home.
  const env = { ...process.env, ...(home === undefined ? {} : { HOME: home }) }
  return { args, env: { ...env, ...agentGitEnvironment(git) } }
})

const resumeFailure = (cause: unknown) =>
  new WorkspaceError({
    operation: "wake claude session",
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  })

/** Interruption aborts the turn and waits until the turn returns, which happens only
 * after its PTY helper confirmed the process group reaped and the PTY at EOF (or the
 * turn failed with unconfirmed cleanup). Escaped sessions are outside this group. */
const interactiveTurn = (run: (signal: AbortSignal) => Promise<string>) =>
  Effect.callback<string, WorkspaceError>((resume, signal) => {
    const running = run(signal)
    running.then(
      (answer) => resume(Effect.succeed(answer)),
      (cause: unknown) => resume(Effect.fail(resumeFailure(cause))),
    )
    return Effect.promise(() =>
      running.then(
        () => undefined,
        () => undefined,
      ),
    )
  })

/** One resumed turn in a private PTY; the answer keeps the CLI result envelope. */
const resumeInteractive = (
  binary: string,
  input: Parameters<ClaudeCliPort["resume"]>[0],
  git?: AgentGitConfig,
  home?: string,
) =>
  prepareClaudeResume(binary, input, git, home).pipe(
    Effect.flatMap((prepared) =>
      interactiveTurn(async (signal) => {
        const directory = await mkdtemp(join(tmpdir(), "workflowd-claude-turn-"))
        try {
          const outcome = await runClaudeInteractiveTurn({
            args: prepared.args,
            prompt: input.prompt,
            directory: input.directory,
            session: input.nativeSessionId,
            env: prepared.env,
            hooksPath: join(directory, "hooks"),
            signal,
          })
          if (!outcome.completed) throw new Error(outcome.failure ?? "claude resume did not complete")
          // The bound covers the actual serialized envelope, including JSON escapes.
          const envelope = JSON.stringify({ type: "result", is_error: false, result: outcome.text })
          if (Buffer.byteLength(envelope) > MAX_CLAUDE_STDOUT_BYTES)
            throw new Error("claude resume output exceeds its limit")
          return envelope
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }),
    ),
  )

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
          // Argument-vector spawn: untrusted session content is one argument after
          // "--" and never appears in a shell string.
          withCredentialAdmission(
            options.credentialSocket,
            "claude",
            resumeInteractive(options.binary, input, options.git, options.home).pipe(
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
