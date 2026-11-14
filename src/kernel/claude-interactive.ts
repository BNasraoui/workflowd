import { constants } from "node:fs"
import { lstat, open, readFile, realpath, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Option, Schema } from "effect"
import { claudeProjectArguments } from "../execution/project-config"
import { nativeSandboxArguments } from "../sandbox/native"
import { claudePtyHelper } from "./claude-pty"

/**
 * Normal interactive Claude Code turns. Print/headless modes are never used. The
 * prompt reaches Claude only through its private PTY (see claude-pty.ts), never argv.
 * Hook records and transcript lines are agent-writable observations: they select the
 * session, prompt confirmation and answer text; the owned exit status and the helper's
 * confirmed process-group/PTY cleanup decide completion.
 */

const hookNames = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "Elicitation",
]

/** Foreground-only turns and Claude's own hook records appended to the worker's
 * private file. `skipDangerousModePermissionPrompt` only affects the dispatched turn's
 * existing bypass selection (print mode never showed that dialog); it is inert for a
 * resumed turn, which keeps the user's permission mode. */
export const claudeInteractiveSettings = JSON.stringify({
  env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
  skipDangerousModePermissionPrompt: true,
  hooks: Object.fromEntries(
    hookNames.map((name) => [
      name,
      [
        {
          hooks: [
            {
              type: "command",
              command: '{ cat; echo; } >> "$WORKFLOWD_CLAUDE_HOOKS"',
              timeout: 5,
            },
          ],
        },
      ],
    ]),
  ),
})

const emptyMcp = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
// The agent-host admitted prompt bound (protocol HostText), unchanged.
const maxPromptCharacters = 262_144
const hookBytes = 8 * 1024 * 1024
const transcriptBytes = 1024 ** 3
const recordBytes = 16 * 1024 * 1024
const helperOutputBytes = 1024 * 1024
const startupMs = 120_000
const closeMs = 5_000
// The helper's own cleanup is bounded at about 10s; this outer bound covers it.
const helperCloseMs = 15_000

export type ClaudeLaunch = {
  readonly binary: string
  readonly directory: string
  readonly model: string | null
  readonly effort?: string
  readonly sandboxBindingFile?: string
}
export type ClaudeSession = { readonly id: string; readonly resume: boolean }

/** A dispatched turn keeps the shared host's established fresh-run selection. A resumed
 * turn keeps the admitted user policy: user settings, MCP servers, allowed tools and
 * permission mode, with repository-local settings excluded. */
export const claudeInteractiveArguments = async (launch: ClaudeLaunch, session: ClaudeSession) => [
  launch.binary,
  "--settings",
  claudeInteractiveSettings,
  ...(session.resume
    ? claudeProjectArguments
    : launch.sandboxBindingFile === undefined
      ? [...claudeProjectArguments, "--dangerously-skip-permissions", ...emptyMcp]
      : await nativeSandboxArguments(
          "claude",
          launch.binary,
          launch.directory,
          launch.sandboxBindingFile,
        )),
  ...(launch.model === null ? [] : ["--model", launch.model]),
  ...(launch.effort === undefined ? [] : ["--effort", launch.effort]),
  session.resume ? "--resume" : "--session-id",
  session.id,
]

export type ClaudeTurnOutcome = {
  readonly exitCode: number
  readonly completed: boolean
  readonly text: string
  readonly failure: string | null
  /** Bounded PTY display tail for private diagnosis; never completion evidence. */
  readonly diagnostic: string
  readonly outputTokens: number
}

type TurnInput = {
  readonly args: ReadonlyArray<string>
  readonly prompt: string
  readonly directory: string
  readonly session: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly hooksPath: string
  readonly signal?: AbortSignal
  readonly deadline?: number
  readonly onStart?: (model: string | null) => Promise<void>
  readonly onRecord?: (line: string) => Promise<void>
}

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

/** CR line endings become LF; other controls could end a paste or act as keys. */
export function admitClaudePrompt(prompt: string) {
  const text = prompt.replace(/\r\n?/g, "\n")
  if (text.trim() === "" || prompt.length > maxPromptCharacters)
    throw new Error("Claude interactive prompt is empty or exceeds its admitted size")
  for (const character of text) {
    const code = character.charCodeAt(0)
    if ((code < 0x20 && character !== "\n" && character !== "\t") || (code >= 0x7f && code <= 0x9f))
      throw new Error("Claude interactive prompt contains control characters")
  }
  return text
}

/** Unattended first-run configuration belongs to explicit fixtures, never a turn. */
async function requireOnboarded(env: TurnInput["env"]) {
  const directory = env.CLAUDE_CONFIG_DIR ?? env.HOME ?? homedir()
  const config = await readFile(join(directory, ".claude.json"), "utf8").catch(() => null)
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ hasCompletedOnboarding: Schema.Literal(true) })),
  )(config ?? "")
  if (Option.isNone(decoded))
    throw new Error("Claude interactive onboarding is incomplete for this native home")
}

/** Complete UTF-8 JSONL records from one regular file whose identity stays fixed. */
class RecordFile {
  #file: FileHandle | null = null
  #identity: { dev: bigint; ino: bigint } | null = null
  #offset = 0
  #consumed = 0
  #pending = Buffer.alloc(0)
  readonly #decoder = new TextDecoder("utf-8", { fatal: true })

  constructor(
    readonly path: string,
    readonly directories: ReadonlyArray<string>,
    readonly limit: number,
  ) {}

  /** The worker's own record file, created exclusively and held open. */
  static async create(path: string, limit: number) {
    const records = new RecordFile(path, [], limit)
    const file = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const info = await file.stat({ bigint: true })
      records.#identity = { dev: info.dev, ino: info.ino }
      records.#file = file
      return records
    } catch (error) {
      await file.close()
      throw error
    }
  }

  async #directoriesReady() {
    for (const directory of this.directories) {
      const info = await lstat(directory).catch((error: unknown) => {
        if (missing(error)) return null
        throw error
      })
      if (info === null) return false
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Claude transcript directory is not a real directory")
    }
    return true
  }

  /** False while not created yet; anything unexpected is refused, never followed. */
  async admit() {
    if (this.#file !== null) return true
    if (!(await this.#directoriesReady())) return false
    let file: FileHandle
    try {
      // Nonblocking: an agent-written FIFO cannot stall observation.
      file = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
    } catch (error) {
      if (missing(error)) return false
      throw new Error("Claude transcript is not a readable regular file", { cause: error })
    }
    try {
      const info = await file.stat({ bigint: true })
      if (!info.isFile()) throw new Error("Claude transcript is not a regular file")
      this.#identity = { dev: info.dev, ino: info.ino }
      if (!(await this.#directoriesReady())) throw new Error("Claude transcript directory moved")
      await this.#verify()
      this.#file = file
      return true
    } catch (error) {
      await file.close()
      throw error
    }
  }

  async #verify() {
    const info = await lstat(this.path, { bigint: true }).catch(() => null)
    if (info === null || info.dev !== this.#identity?.dev || info.ino !== this.#identity.ino)
      throw new Error("Claude observation file was replaced")
  }

  /** A resumed transcript already holds earlier turns; observe only this one. */
  async startAtEnd() {
    if (this.#file !== null) this.#offset = Number((await this.#file.stat()).size)
  }

  async lines() {
    const file = (await this.admit()) ? this.#file : null
    if (file === null) return []
    await this.#verify()
    const lines: string[] = []
    const chunk = Buffer.alloc(65_536)
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, this.#offset)
      if (bytesRead === 0) return lines
      this.#offset += bytesRead
      this.#consumed += bytesRead
      if (this.#consumed > this.limit) throw new Error("Claude observation capacity")
      // Records split on LF bytes, which never occur inside a multibyte character.
      let data = Buffer.concat([this.#pending, chunk.subarray(0, bytesRead)])
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10)) {
        const line = this.#decoder.decode(data.subarray(0, end))
        data = data.subarray(end + 1)
        if (line.trim() !== "") lines.push(line)
      }
      if (data.length > recordBytes) throw new Error("Claude observation record capacity")
      this.#pending = Buffer.from(data)
    }
  }

  /** After the writer is gone, a trailing partial record is lost data, not a record. */
  finish() {
    if (this.#pending.length > 0) throw new Error("Claude observation ended mid-record")
  }

  async close() {
    const file = this.#file
    this.#file = null
    await file?.close()
  }
}

const HookRecord = Schema.Struct({
  session_id: Schema.String,
  hook_event_name: Schema.String,
  transcript_path: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  last_assistant_message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  tool_name: Schema.optionalKey(Schema.String),
})
const decodeHook = Schema.decodeUnknownOption(Schema.fromJsonString(HookRecord))

const MessageRecord = Schema.Struct({
  type: Schema.Literals(["user", "assistant"]),
  sessionId: Schema.optionalKey(Schema.String),
  isSidechain: Schema.optionalKey(Schema.Boolean),
  isApiErrorMessage: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Unknown),
  message: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.Unknown),
    usage: Schema.optionalKey(
      Schema.Struct({ output_tokens: Schema.optionalKey(Schema.Number) }),
    ),
  }),
})
const decodeMessage = Schema.decodeUnknownOption(MessageRecord)

const HelperEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("started"), pid: Schema.Number }),
  Schema.Struct({ event: Schema.Literal("submitted") }),
  Schema.Struct({ event: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({
    event: Schema.Literal("closed"),
    pid: Schema.Number,
    exitCode: Schema.NullOr(Schema.Number),
    leaderReaped: Schema.Boolean,
    groupEmpty: Schema.Boolean,
    outputClosed: Schema.Boolean,
    tail: Schema.String,
  }),
])
type HelperEvent = typeof HelperEvent.Type
const decodeHelperEvent = Schema.decodeUnknownOption(Schema.fromJsonString(HelperEvent))

const contentText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string"
            ? block.text
            : "",
        )
        .join("")
    : ""

type Observation = {
  verified: boolean
  started: boolean
  stopped: { text: string | null } | null
  failure: string | null
  finishing: boolean
  cancelling: boolean
  text: string
  tokens: Map<string, number>
}

async function observeHook(
  input: TurnInput,
  state: Observation,
  expected: { transcript: string; prompt: string },
  line: string,
  control: (value: object) => void,
) {
  const hook = Option.getOrUndefined(decodeHook(line))
  if (hook === undefined) throw new Error("Claude hook record is malformed")
  if (hook.session_id !== input.session) throw new Error("Claude hook session changed")
  switch (hook.hook_event_name) {
    case "SessionStart":
      if (hook.transcript_path !== expected.transcript)
        throw new Error("Claude transcript is not this session's transcript")
      if (state.started) return
      state.started = true
      await input.onStart?.(hook.model ?? null)
      control({ op: "submit" })
      return
    case "UserPromptSubmit":
      if (state.verified || !state.started) throw new Error("Claude received an unexpected prompt")
      // Claude trims submitted input; everything else must be the literal prompt.
      if (hook.prompt?.trim() !== expected.prompt.trim())
        throw new Error("Claude received a different prompt than was submitted")
      state.verified = true
      return
    case "Stop":
      if (!state.verified) throw new Error("Claude stopped before its prompt was submitted")
      state.stopped ??= { text: hook.last_assistant_message ?? null }
      return
    case "StopFailure":
      // A failure dominates any earlier or later Stop.
      state.failure ??=
        typeof hook.error === "string"
          ? hook.error.slice(0, 2048)
          : `Claude turn failed: ${JSON.stringify(hook.error ?? null).slice(0, 2048)}`
      return
    case "PermissionRequest":
    case "Elicitation":
      throw new Error(
        `Claude asked an interactive ${hook.hook_event_name} question` +
          (hook.tool_name === undefined ? "" : ` (${hook.tool_name.slice(0, 256)})`),
      )
    default:
      return
  }
}

async function observeTranscript(input: TurnInput, state: Observation, line: string) {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("Claude transcript record is malformed")
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    (value.type !== "user" && value.type !== "assistant")
  )
    return
  const message = Option.getOrUndefined(decodeMessage(value))
  if (message === undefined) throw new Error("Claude transcript message is malformed")
  if (message.sessionId !== undefined && message.sessionId !== input.session)
    throw new Error("Claude transcript session changed")
  // The print stream's main-thread messages: model output and its tool results.
  if (message.isSidechain === true) return
  await input.onRecord?.(line)
  if (message.type !== "assistant") return
  const tokens = message.message.usage?.output_tokens
  if (tokens !== undefined) {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new Error("Claude transcript usage is malformed")
    if (message.message.id !== undefined) state.tokens.set(message.message.id, tokens)
  }
  const text = contentText(message.message.content)
  if (message.isApiErrorMessage === true || message.error !== undefined)
    state.failure ??= `Claude API error: ${text.slice(0, 2048) || "unspecified"}`
  if (text !== "") state.text = text
}

async function readHelperEvents(stream: ReadableStream<Uint8Array>, events: HelperEvent[]) {
  const decoder = new TextDecoder()
  let pending = ""
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > helperOutputBytes) throw new Error("Claude helper output capacity")
    pending += decoder.decode(chunk, { stream: true })
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const event = Option.getOrUndefined(decodeHelperEvent(pending.slice(0, end)))
      if (event === undefined) throw new Error("Claude helper record is malformed")
      events.push(event)
      pending = pending.slice(end + 1)
    }
  }
  if ((pending + decoder.decode()).trim() !== "") throw new Error("Claude helper record is partial")
}

const settled = <A>(promise: Promise<A>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)])

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Run one normal turn. The helper process, its PTY child group and both record files
 * are owned from acquisition; every release runs and unconfirmed cleanup fails. */
export async function runClaudeInteractiveTurn(input: TurnInput): Promise<ClaudeTurnOutcome> {
  const prompt = admitClaudePrompt(input.prompt)
  await requireOnboarded(input.env)
  const configRoot = input.env.CLAUDE_CONFIG_DIR ?? join(input.env.HOME ?? homedir(), ".claude")
  // Claude names a session's transcript from its real working directory.
  const project = (await realpath(input.directory)).replace(/[^A-Za-z0-9-]/g, "-")
  const transcriptPath = join(configRoot, "projects", project, `${input.session}.jsonl`)
  const transcript = new RecordFile(
    transcriptPath,
    [join(configRoot, "projects"), join(configRoot, "projects", project)],
    transcriptBytes,
  )
  const hooks = await RecordFile.create(input.hooksPath, hookBytes)
  let result: { outcome: ClaudeTurnOutcome } | { error: unknown }
  try {
    if (await transcript.admit()) await transcript.startAtEnd()
    result = { outcome: await converse(input, prompt, transcriptPath, hooks, transcript) }
  } catch (error) {
    result = { error }
  }
  const failures: unknown[] = []
  for (const release of [() => hooks.close(), () => transcript.close()])
    await release().catch((error: unknown) => failures.push(error))
  // A release failure never replaces the turn's own error.
  if ("error" in result) throw result.error
  if (failures.length > 0) throw failures[0]
  return result.outcome
}

async function converse(
  input: TurnInput,
  prompt: string,
  transcriptPath: string,
  hooks: RecordFile,
  transcript: RecordFile,
): Promise<ClaudeTurnOutcome> {
  const helper = Bun.spawn(["/usr/bin/python3", "-I", "-c", claudePtyHelper], {
    cwd: input.directory,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const events: HelperEvent[] = []
  const reading = readHelperEvents(helper.stdout, events).then(
    () => null,
    (error: unknown) => error,
  )
  const control = (value: object) => {
    try {
      helper.stdin.write(JSON.stringify(value) + "\n")
      void Promise.resolve(helper.stdin.flush()).catch(() => undefined)
    } catch {
      // A closed helper is observed through its exit and missing closed record.
    }
  }
  const state: Observation = {
    verified: false,
    started: false,
    stopped: null,
    failure: null,
    finishing: false,
    cancelling: false,
    text: "",
    tokens: new Map(),
  }
  const expected = { transcript: transcriptPath, prompt }
  let closeAt: number | null = null
  const stop = (operation: "finish" | "cancel", reason?: string): void => {
    if (reason !== undefined) state.failure ??= reason
    if (operation === "finish" ? state.finishing || state.cancelling : state.cancelling) return
    state[operation === "finish" ? "finishing" : "cancelling"] = true
    closeAt ??= Date.now() + closeMs
    control({ op: operation })
  }
  const observe = async () => {
    for (const line of await hooks.lines())
      await observeHook(input, state, expected, line, control)
    for (const line of await transcript.lines()) await observeTranscript(input, state, line)
  }
  const launchedAt = Date.now()
  let cleanup: string | null = null
  try {
    const env = Object.fromEntries(
      Object.entries({
        ...input.env,
        TERM: "xterm-256color",
        WORKFLOWD_CLAUDE_HOOKS: input.hooksPath,
        // Print mode never consulted or persisted workspace trust; keep that for both
        // shared-host turn kinds without editing any user configuration.
        CLAUDE_CODE_SANDBOXED: "1",
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    control({ argv: input.args, cwd: input.directory, env, paste: prompt })
    while (helper.exitCode === null && helper.signalCode === null) {
      try {
        await observe()
      } catch (error) {
        stop("cancel", describe(error))
      }
      const next = nextStop(input, state, closeAt, launchedAt)
      if (next !== null) stop(...next)
      // A cancelled helper's bounded cleanup is awaited by closeHelper below.
      if (state.cancelling) break
      await settled(helper.exited, 100)
    }
  } catch (error) {
    state.failure ??= describe(error)
  } finally {
    cleanup = await closeHelper(helper, control, reading, events)
  }
  try {
    await observe()
    hooks.finish()
    transcript.finish()
  } catch (error) {
    state.failure ??= describe(error)
  }
  if (cleanup !== null)
    throw new Error(
      `Claude process cleanup unconfirmed: ${cleanup}` +
        (state.failure === null ? "" : `; turn: ${state.failure}`),
    )
  return turnOutcome(state, events)
}

/** The next lifecycle request for this poll, if any. Failures dominate completion. */
function nextStop(
  input: TurnInput,
  state: Observation,
  closeAt: number | null,
  launchedAt: number,
): ["finish" | "cancel", string?] | null {
  const now = Date.now()
  if (input.signal?.aborted) return ["cancel", "Claude interactive turn was cancelled"]
  if (closeAt !== null && now >= closeAt) return ["cancel", "Claude did not exit after its turn"]
  if (!state.verified && now - launchedAt >= startupMs)
    return ["cancel", "Claude did not accept its prompt"]
  if (input.deadline !== undefined && now >= input.deadline)
    return ["cancel", "Claude interactive turn did not finish before its deadline"]
  if (state.failure !== null) return [state.stopped === null ? "cancel" : "finish"]
  return state.stopped === null ? null : ["finish"]
}

function turnOutcome(state: Observation, events: ReadonlyArray<HelperEvent>): ClaudeTurnOutcome {
  const closed = events.find((event) => event.event === "closed")
  const failed = events.find((event) => event.event === "failed")
  const launched = events.some((event) => event.event === "started")
  if (failed?.event === "failed")
    state.failure ??= `Claude ${launched ? "PTY helper" : "launch"} failed (${failed.error})`
  const status = closed?.event === "closed" ? (closed.exitCode ?? -1) : -1
  const completed =
    state.failure === null &&
    state.verified &&
    state.stopped !== null &&
    state.finishing &&
    !state.cancelling &&
    status === 0
  return {
    exitCode: completed ? 0 : status === 0 ? 1 : status,
    completed,
    text: state.stopped?.text ?? state.text,
    failure: completed
      ? null
      : (state.failure ?? `Claude exited ${status} without a completed turn`),
    diagnostic:
      closed?.event === "closed"
        ? Bun.stripANSI(closed.tail)
            .replace(/[^\n\t\x20-\x7e]/g, "")
            .slice(-1024)
        : "",
    outputTokens: [...state.tokens.values()].reduce((sum, count) => sum + count, 0),
  }
}

/** Every release step runs; returns the reason cleanup could not be confirmed. */
async function closeHelper(
  helper: Bun.Subprocess<"pipe", "pipe", "ignore">,
  control: (value: object) => void,
  reading: Promise<unknown>,
  events: HelperEvent[],
): Promise<string | null> {
  const problems: string[] = []
  if (helper.exitCode === null && helper.signalCode === null) {
    control({ op: "cancel" })
    if (!(await settled(helper.exited, helperCloseMs))) {
      problems.push("PTY helper did not finish its cleanup")
      helper.kill("SIGKILL")
      if (!(await settled(helper.exited, 2_000))) problems.push("PTY helper was not reaped")
    }
  }
  try {
    await helper.stdin.end()
  } catch {
    // Already closed with the exited helper.
  }
  const readError = (await settled(reading, 2_000)) ? await reading : "unfinished"
  if (readError !== null) problems.push(`helper records unavailable (${describe(readError)})`)
  const launched = events.some((event) => event.event === "started")
  const closed = events.find((event) => event.event === "closed")
  if (launched) {
    if (closed?.event !== "closed") problems.push("no closed record")
    else {
      if (!closed.leaderReaped) problems.push("Claude was not reaped")
      if (!closed.groupEmpty) problems.push("process group still has members")
      if (!closed.outputClosed) problems.push("PTY output did not reach EOF")
    }
  }
  return problems.length === 0 ? null : problems.join("; ")
}
