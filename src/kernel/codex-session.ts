import { Context, Effect } from "effect"
import { normalizeError } from "../errors"
import { runWorkspaceCommand } from "../workspace/command"
import { WorkspaceError } from "../workspace/errors"

/**
 * Codex CLI sessions are threads under the daemon host's `~/.codex`
 * directory, and the `codex exec --json` subcommand is their programmatic
 * surface: it runs one non-interactive turn in a working directory, prints
 * the event stream as JSONL on stdout, and exits when the turn is over.
 * That subprocess is the codex analog of OpenCode's promptAsync —
 * deliberately the only way workflowd ever drives a codex model.
 */
export const CODEX_PROVIDER_ID = "codex-cli"
export const CODEX_ENDPOINT_ALIAS = "local-cli"

export const codexSessionCustodyId = (nativeSessionId: string) => `codex-session-${nativeSessionId}`

export const codexEndpointIdentity = (owningHostId: string) => `codex-cli://${owningHostId}`

/**
 * The subset of the `codex exec --json` event stream the runner acts on,
 * parsed from one JSONL line. Everything else (command executions, reasoning
 * items, diffs) decodes to "other" and is ignored. Shapes captured from a
 * real codex-cli 0.153.4 run; see test/kernel/codex-session.test.ts.
 */
export type CodexExecEvent =
  | { readonly type: "thread.started"; readonly threadId: string }
  | { readonly type: "turn.started" }
  | { readonly type: "agent_message"; readonly text: string }
  | { readonly type: "turn.completed"; readonly outputTokens: number | null }
  | { readonly type: "turn.failed"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "other" }

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

const field = (value: object, key: string): unknown => Reflect.get(value, key)

const textField = (value: object, key: string): string | null => {
  const raw = field(value, key)
  return typeof raw === "string" ? raw : null
}

const numberField = (value: object, key: string): number | null => {
  const raw = field(value, key)
  return typeof raw === "number" ? raw : null
}

/** Parses one JSONL line of the codex exec event stream; malformed or
 * unrecognized lines decode to "other" rather than killing the run. */
export const parseCodexExecEvent = (line: string): CodexExecEvent => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { type: "other" }
  }
  if (!isObject(value)) return { type: "other" }
  switch (field(value, "type")) {
    case "thread.started": {
      const threadId = textField(value, "thread_id")
      return threadId !== null && threadId !== ""
        ? { type: "thread.started", threadId }
        : { type: "other" }
    }
    case "turn.started":
      return { type: "turn.started" }
    case "item.completed": {
      const item = field(value, "item")
      if (!isObject(item)) return { type: "other" }
      if (field(item, "type") === "agent_message") {
        const text = textField(item, "text")
        return text !== null ? { type: "agent_message", text } : { type: "other" }
      }
      if (field(item, "type") === "error") {
        const message = textField(item, "message")
        return message !== null ? { type: "error", message } : { type: "other" }
      }
      return { type: "other" }
    }
    case "turn.completed": {
      const usage = field(value, "usage")
      return {
        type: "turn.completed",
        outputTokens: isObject(usage) ? numberField(usage, "output_tokens") : null,
      }
    }
    case "turn.failed": {
      const error = field(value, "error")
      const message = isObject(error) ? textField(error, "message") : null
      return {
        type: "turn.failed",
        message: message ?? "codex turn failed without a message",
      }
    }
    case "error": {
      const message = textField(value, "message")
      return message !== null ? { type: "error", message } : { type: "other" }
    }
    default:
      return { type: "other" }
  }
}

const AUTH_FAILURE_PATTERN = /401|unauthorized|not logged in|missing bearer/i

/** Heuristic over collected codex error text: did the failure look like
 * missing or rejected credentials rather than a model/turn problem? */
export const codexFailureLooksUnauthenticated = (messages: ReadonlyArray<string>) =>
  messages.some((message) => AUTH_FAILURE_PATTERN.test(message))

export type CodexPreflightError = {
  readonly kind: "cli_unusable" | "not_authenticated"
  readonly detail: string
}

export type CodexExit = {
  /** Signal death (null) maps to -1 so every caller treats only 0 as success. */
  readonly exitCode: number
  readonly stderr: string
}

/** One live codex exec process. `events` is single-consumer: the dispatch
 * drains it to the first-token receipt and the completion continuation
 * drains the rest. */
export type CodexRunProcess = {
  readonly events: AsyncIterable<CodexExecEvent>
  /** Resolves on process exit with the exit code and bounded stderr.
   * Interrupting this effect terminates the process group (SIGTERM, then
   * SIGKILL), so a no-first-token refusal never leaves codex burning. */
  readonly exited: Effect.Effect<CodexExit, WorkspaceError>
}

export type CodexSpawnInput = {
  /** Absolute path of the prepared git worktree codex works in (--cd). */
  readonly directory: string
  /** The task prompt; rides stdin, never argv. */
  readonly prompt: string
  /** Codex model id (-m), or null for the CLI's configured default. */
  readonly model: string | null
}

export type CodexCliPort = {
  /** Checks the CLI answers a version call and reports credentials on the
   * daemon host. Both failures refuse the dispatch before anything spawns. */
  readonly preflight: Effect.Effect<void, CodexPreflightError>
  /** Spawns `codex exec --json` in the given directory. Fails only when the
   * process cannot be started; the run's outcome arrives via events+exit. */
  readonly spawn: (input: CodexSpawnInput) => Effect.Effect<CodexRunProcess, WorkspaceError>
}

export const CodexCli = Context.Service<CodexCliPort>("workflowd/kernel/CodexCli")

const MAX_CODEX_STDERR_BYTES = 16_384

export const makeCodexCli = (options: { readonly binary: string }): CodexCliPort => ({
  preflight: Effect.gen(function* () {
    yield* runWorkspaceCommand("check codex cli", [options.binary, "--version"]).pipe(
      Effect.mapError((cause): CodexPreflightError => ({
        kind: "cli_unusable",
        detail: `the codex CLI did not answer a version check on the daemon host: ${String(cause.cause)}`,
      })),
    )
    yield* runWorkspaceCommand("check codex auth", [options.binary, "login", "status"]).pipe(
      Effect.mapError((cause): CodexPreflightError => ({
        kind: "not_authenticated",
        detail: `the codex CLI has no credentials on the daemon host (codex login status failed): ${String(cause.cause)}`,
      })),
    )
  }),
  spawn: (input) =>
    Effect.callback<CodexRunProcess, WorkspaceError>((resume) => {
      // Argument-vector spawn, prompt on stdin: untrusted task text never
      // appears in argv or a shell string. Bypassing the sandbox is
      // deliberate, matching the opencode YOLO posture: runs happen in
      // dedicated git worktrees on a trusted host and must push over the
      // network.
      const argv = [
        options.binary,
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        input.directory,
        ...(input.model === null ? [] : ["-m", input.model]),
        "-",
      ]
      let child: Bun.ReadableSubprocess
      try {
        child = Bun.spawn(argv, {
          cwd: input.directory,
          detached: true,
          env: process.env,
          stdin: Buffer.from(input.prompt, "utf8"),
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (cause) {
        resume(
          Effect.fail(
            new WorkspaceError({ operation: "spawn codex exec", cause: normalizeError(cause) }),
          ),
        )
        return
      }

      const queue = makeEventQueue()
      const stdoutClosed = readLines(child.stdout, (line) => queue.push(parseCodexExecEvent(line)))
      const stderrText = readBoundedText(child.stderr, MAX_CODEX_STDERR_BYTES)
      void Promise.all([child.exited, stdoutClosed]).then(() => queue.close())

      const terminateGroup = (signalName: "SIGTERM" | "SIGKILL") => {
        try {
          process.kill(-child.pid, signalName)
        } catch {
          try {
            child.kill(signalName)
          } catch {
            // Already gone.
          }
        }
      }
      const groupIsAlive = () => {
        try {
          process.kill(-child.pid, 0)
          return true
        } catch {
          return false
        }
      }

      // The exit lands whenever the process dies, but `exited` may only be
      // evaluated later (or never); cache the result so a late evaluation
      // still resumes immediately.
      let awaitExit: ((effect: Effect.Effect<CodexExit, WorkspaceError>) => void) | null = null
      let exitResult: CodexExit | null = null
      void child.exited.then((code) =>
        stderrText.then((stderr) => {
          exitResult = { exitCode: typeof code === "number" ? code : -1, stderr }
          const pending = awaitExit
          awaitExit = null
          pending?.(Effect.succeed(exitResult))
        }),
      )

      resume(
        Effect.succeed({
          events: queue.iterable,
          exited: Effect.callback<CodexExit, WorkspaceError>((resumeDone, exitSignal) => {
            if (exitResult !== null) {
              resumeDone(Effect.succeed(exitResult))
              return
            }
            awaitExit = resumeDone
            // Interruption (no-first-token timeout, daemon shutdown) is the
            // process-group kill, awaited to completion like workspace
            // commands so a refused dispatch never leaves codex burning.
            exitSignal.addEventListener("abort", () => terminateGroup("SIGTERM"), {
              once: true,
            })
            return Effect.tryPromise({
              try: async () => {
                terminateGroup("SIGTERM")
                const completed = await Promise.race([
                  child.exited.then(() => true),
                  Bun.sleep(500).then(() => false),
                ])
                if (!completed || groupIsAlive()) terminateGroup("SIGKILL")
                await child.exited
                for (let attempt = 0; attempt < 50 && groupIsAlive(); attempt += 1) {
                  await Bun.sleep(10)
                }
                if (groupIsAlive()) {
                  throw new Error(`codex process group ${child.pid} remained alive after cleanup`)
                }
              },
              catch: normalizeError,
            }).pipe(
              Effect.tapError((cause) => Effect.logWarning("codex exec cleanup failed", { cause })),
              Effect.orDie,
            )
          }),
        }),
      )
    }),
})

/** Single-consumer push queue turning stdout lines into an async iterable. */
const makeEventQueue = () => {
  const pending: CodexExecEvent[] = []
  let closed = false
  let waiter: (() => void) | null = null
  const wake = () => {
    const ready = waiter
    waiter = null
    ready?.()
  }
  const next = async (): Promise<IteratorResult<CodexExecEvent>> => {
    for (;;) {
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      if (closed) return { value: undefined, done: true }
      await new Promise<void>((resolve) => {
        waiter = resolve
      })
    }
  }
  const iterator: AsyncIterator<CodexExecEvent> = { next }
  return {
    push: (event: CodexExecEvent) => {
      if (closed) return
      pending.push(event)
      wake()
    },
    close: () => {
      closed = true
      wake()
    },
    iterable: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<CodexExecEvent>,
  }
}

const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) => {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== "") onLine(line)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim() !== "") onLine(buffer)
}

const readBoundedText = async (stream: ReadableStream<Uint8Array>, maxBytes: number) => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const room = merged.byteLength - offset
    if (room <= 0) break
    const copied = Math.min(room, chunk.byteLength)
    merged.set(chunk.subarray(0, copied), offset)
    offset += copied
  }
  return new TextDecoder().decode(merged)
}
