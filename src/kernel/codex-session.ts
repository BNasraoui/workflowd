import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Schema } from "effect"
import { normalizeError } from "../errors"
import { runWorkspaceCommand } from "../workspace/command"
import { WorkspaceError } from "../workspace/errors"
import { incrementalLines } from "./codex-output"

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
  readonly kind: "cli_unusable" | "not_authenticated" | "systemd_unavailable"
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
  readonly executionId: string
  readonly events: AsyncIterable<CodexExecEvent>
  /** Observation is independent of the transient service; interruption does
   * not signal the worker. */
  readonly exited: Effect.Effect<CodexExit, WorkspaceError>
  /** Explicit cancellation is the only operation that signals the unit. */
  readonly cancel: Effect.Effect<void, WorkspaceError>
}

export type CodexSpawnInput = {
  readonly runId: string
  readonly directory: string
  readonly prompt: string
  readonly model: string | null
}

export type CodexCliPort = {
  readonly preflight: Effect.Effect<void, CodexPreflightError>
  readonly spawn: (input: CodexSpawnInput) => Effect.Effect<CodexRunProcess, WorkspaceError>
  readonly attach: (input: {
    readonly runId: string
  }) => Effect.Effect<CodexRunProcess | null, WorkspaceError>
}

export const CodexCli = Context.Service<CodexCliPort>("workflowd/kernel/CodexCli")

const MAX_CODEX_STDERR_BYTES = 16_384
type CommandResult = {
  readonly exitCode: number
  readonly stdout?: string
  readonly stderr: string
}
type RunCommand = (command: ReadonlyArray<string>) => Promise<CommandResult>

export type CodexCliOptions = {
  readonly binary: string
  readonly custodyRoot: string
  readonly pollIntervalMs?: number
  readonly maxOutputBytes?: number
  readonly observationTimeoutMs?: number
  readonly cancellationGraceMs?: number
  readonly commandTimeoutMs?: number
  readonly runCommand?: RunCommand
}

const Manifest = Schema.Struct({
  version: Schema.Literal(2),
  runId: Schema.String,
  launchId: Schema.String,
  executionId: Schema.String,
  invocationId: Schema.NullOr(Schema.String),
  eventsPath: Schema.String,
  stderrPath: Schema.String,
  resultPath: Schema.String,
  cancelledPath: Schema.String,
})
type Manifest = typeof Manifest.Type

const ResultRecord = Schema.Struct({
  version: Schema.Literal(1),
  exitCode: Schema.Int,
})

const safeRunId = (runId: string) => {
  if (!/^agent-run-[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("run id is not safe for durable custody")
  }
  return runId
}

const executionIdFor = (runId: string) =>
  `workflowd-agent-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}.service`

const defaultRunCommand: RunCommand = async (command) => {
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode: typeof exitCode === "number" ? exitCode : -1, stdout, stderr }
}

const fileExists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

const writeJsonAtomic = async (path: string, value: unknown) => {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" })
  await rename(temporary, path)
}

const readJson = async <S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S) =>
  Schema.decodeUnknownSync(schema)(JSON.parse(await readFile(path, "utf8")))

const boundedText = async (path: string) => {
  try {
    const value = await readFile(path)
    return new TextDecoder().decode(value.subarray(0, MAX_CODEX_STDERR_BYTES))
  } catch {
    return ""
  }
}

const commandFailure = (operation: string, result: CommandResult) =>
  new WorkspaceError({
    operation,
    cause: new Error(`${operation} exited ${result.exitCode}: ${result.stderr.trim()}`),
  })

export const makeCodexCli = (options: CodexCliOptions): CodexCliPort => {
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024
  const observationTimeoutMs = options.observationTimeoutMs ?? 24 * 60 * 60_000
  const cancellationGraceMs = options.cancellationGraceMs ?? 5_000
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000
  const runCommand = options.runCommand ?? defaultRunCommand
  const workerPath = fileURLToPath(new URL("./codex-worker.ts", import.meta.url))
  const manifestPath = (runId: string) =>
    join(options.custodyRoot, safeRunId(runId), "manifest.json")

  const runBoundedCommand = async (arguments_: ReadonlyArray<string>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        runCommand(arguments_),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`command timed out after ${commandTimeoutMs}ms`)),
            commandTimeoutMs,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  type UnitState = {
    readonly present: boolean
    readonly active: boolean
    readonly invocationId: string
    readonly description: string
    readonly result: string
  }
  const inspectUnit = async (executionId: string): Promise<UnitState> => {
    const result = await runBoundedCommand([
      "systemctl",
      "--user",
      "show",
      "--property=InvocationID",
      "--property=Description",
      "--property=ActiveState",
      "--property=SubState",
      "--property=Result",
      "--no-pager",
      executionId,
    ])
    if (result.exitCode !== 0) {
      return { present: false, active: false, invocationId: "", description: "", result: "" }
    }
    const fields = new Map(
      (result.stdout ?? "")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    )
    return {
      present: true,
      active: fields.get("ActiveState") === "active" || fields.get("ActiveState") === "activating",
      invocationId: fields.get("InvocationID") ?? "",
      description: fields.get("Description") ?? "",
      result: fields.get("Result") ?? "",
    }
  }

  const reconcile = async (path: string, manifest: Manifest) => {
    const unit = await inspectUnit(manifest.executionId)
    if (!unit.present) return { manifest, unit }
    const expectedDescription = `workflowd codex launch ${manifest.launchId}`
    if (unit.description !== expectedDescription || unit.invocationId === "") {
      throw new Error("codex transient unit invocation identity mismatch")
    }
    if (manifest.invocationId !== null && manifest.invocationId !== unit.invocationId) {
      throw new Error("codex transient unit invocation identity mismatch")
    }
    if (manifest.invocationId === null) {
      const adopted = { ...manifest, invocationId: unit.invocationId }
      await writeJsonAtomic(path, adopted)
      return { manifest: adopted, unit }
    }
    return { manifest, unit }
  }

  const attach: CodexCliPort["attach"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const path = manifestPath(input.runId)
        if (!(await fileExists(path))) return null
        let manifest = await readJson(path, Manifest)
        if (manifest.runId !== input.runId) throw new Error("codex custody run id mismatch")
        const initial = await reconcile(path, manifest)
        manifest = initial.manifest
        const attachedAt = Date.now()

        const terminal = async (): Promise<CodexExit | null> => {
          if (await fileExists(manifest.resultPath)) {
            const result = await readJson(manifest.resultPath, ResultRecord)
            return { exitCode: result.exitCode, stderr: await boundedText(manifest.stderrPath) }
          }
          if (await fileExists(manifest.cancelledPath)) {
            return { exitCode: -1, stderr: await boundedText(manifest.stderrPath) }
          }
          const reconciled = await reconcile(path, manifest)
          manifest = reconciled.manifest
          if (!reconciled.unit.present) {
            return { exitCode: -1, stderr: "codex transient unit is absent and has no result" }
          }
          if (!reconciled.unit.active) {
            return {
              exitCode: -1,
              stderr: `codex transient unit exited without a result (${reconciled.unit.result || "unknown result"})`,
            }
          }
          return null
        }

        const events = incrementalLines({
          path: manifest.eventsPath,
          pollIntervalMs,
          shouldStop: async () =>
            (await terminal()) !== null || Date.now() - attachedAt >= observationTimeoutMs,
          parse: parseCodexExecEvent,
        })

        const exited = Effect.tryPromise({
          try: async () => {
            for (;;) {
              const exit = await terminal()
              if (exit !== null) return exit
              if (Date.now() - attachedAt >= observationTimeoutMs) {
                return {
                  exitCode: -1,
                  stderr: `codex observation timed out after ${observationTimeoutMs}ms`,
                }
              }
              await Bun.sleep(pollIntervalMs)
            }
          },
          catch: (cause) =>
            new WorkspaceError({
              operation: "observe codex transient unit",
              cause: normalizeError(cause),
            }),
        })

        const cancel = Effect.tryPromise({
          try: async () => {
            const reconciled = await reconcile(path, manifest)
            manifest = reconciled.manifest
            if (!reconciled.unit.present || !reconciled.unit.active) return
            const result = await runBoundedCommand([
              "systemctl",
              "--user",
              "stop",
              manifest.executionId,
            ])
            if (result.exitCode !== 0) {
              throw commandFailure("cancel codex transient unit", result)
            }
            const waitInactive = async (durationMs: number) => {
              const deadline = Date.now() + durationMs
              for (;;) {
                const observed = await reconcile(path, manifest)
                manifest = observed.manifest
                if (!observed.unit.present || !observed.unit.active) return true
                if (Date.now() >= deadline) return false
                await Bun.sleep(pollIntervalMs)
              }
            }
            if (!(await waitInactive(cancellationGraceMs))) {
              const killed = await runBoundedCommand([
                "systemctl",
                "--user",
                "kill",
                "--kill-whom=all",
                "--signal=SIGKILL",
                manifest.executionId,
              ])
              if (killed.exitCode !== 0 || !(await waitInactive(cancellationGraceMs))) {
                throw commandFailure("kill codex transient unit", killed)
              }
            }
            await writeJsonAtomic(manifest.cancelledPath, {
              version: 1,
              invocationId: manifest.invocationId,
            })
          },
          catch: (cause) =>
            cause instanceof WorkspaceError
              ? cause
              : new WorkspaceError({
                  operation: "cancel codex transient unit",
                  cause: normalizeError(cause),
                }),
        })

        return { executionId: manifest.executionId, events, exited, cancel }
      },
      catch: (cause) =>
        new WorkspaceError({
          operation: "attach codex transient unit",
          cause: normalizeError(cause),
        }),
    })

  return {
    preflight: Effect.gen(function* () {
      const manager = yield* Effect.tryPromise({
        try: () => runBoundedCommand(["systemctl", "--user", "show-environment"]),
        catch: (cause): CodexPreflightError => ({
          kind: "systemd_unavailable",
          detail: `the user systemd manager is unavailable: ${normalizeError(cause).message}`,
        }),
      })
      if (manager.exitCode !== 0) {
        return yield* Effect.fail({
          kind: "systemd_unavailable" as const,
          detail: `the user systemd manager is unavailable: ${manager.stderr.trim()}`,
        })
      }
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
      Effect.tryPromise({
        try: async () => {
          try {
            safeRunId(input.runId)
            const directory = join(options.custodyRoot, input.runId)
            const executionId = executionIdFor(input.runId)
            const launchId = crypto.randomUUID()
            const promptPath = join(directory, "prompt")
            const eventsPath = join(directory, "events.jsonl")
            const stderrPath = join(directory, "stderr.log")
            const resultPath = join(directory, "result.json")
            const cancelledPath = join(directory, "cancelled.json")
            await mkdir(directory, { recursive: true, mode: 0o700 })
            await chmod(directory, 0o700)
            await writeFile(promptPath, input.prompt, { mode: 0o600, flag: "wx" })
            await writeFile(eventsPath, "", { mode: 0o600, flag: "wx" })
            await writeFile(stderrPath, "", { mode: 0o600, flag: "wx" })
            const manifest: Manifest = {
              version: 2,
              runId: input.runId,
              launchId,
              executionId,
              invocationId: null,
              eventsPath,
              stderrPath,
              resultPath,
              cancelledPath,
            }
            await writeJsonAtomic(manifestPath(input.runId), manifest)

            const forwardedEnvironment = [
              "HOME",
              "PATH",
              "CODEX_HOME",
              "SSH_AUTH_SOCK",
              "GIT_CONFIG_GLOBAL",
              "GIT_SSH_COMMAND",
              "XDG_CONFIG_HOME",
              "XDG_DATA_HOME",
              "XDG_STATE_HOME",
              "XDG_CACHE_HOME",
            ].flatMap((name) => {
              const value = process.env[name]
              return value === undefined ? [] : [`--setenv=${name}=${value}`]
            })
            const command = [
              "systemd-run",
              "--user",
              "--quiet",
              "--service-type=exec",
              `--unit=${executionId}`,
              `--description=workflowd codex launch ${launchId}`,
              `--working-directory=${input.directory}`,
              "--property=KillMode=control-group",
              ...forwardedEnvironment,
              process.execPath,
              workerPath,
              "--binary",
              options.binary,
              "--directory",
              input.directory,
              "--prompt-file",
              promptPath,
              "--result-file",
              resultPath,
              "--events-file",
              eventsPath,
              "--stderr-file",
              stderrPath,
              "--max-output-bytes",
              String(maxOutputBytes),
              ...(input.model === null ? [] : ["--model", input.model]),
            ]
            const launched = await runBoundedCommand(command)
            if (launched.exitCode !== 0)
              throw commandFailure("launch codex transient unit", launched)
            const process_ = await Effect.runPromise(attach({ runId: input.runId }))
            if (process_ === null) throw new Error("codex custody vanished after launch")
            return process_
          } catch (cause) {
            await rm(join(options.custodyRoot, input.runId), { recursive: true, force: true })
            throw cause
          }
        },
        catch: (cause) =>
          cause instanceof WorkspaceError
            ? cause
            : new WorkspaceError({
                operation: "launch codex transient unit",
                cause: normalizeError(cause),
              }),
      }),
    attach,
  }
}
