import { installAgentGitGuard, refreshAgentGitGuard } from "../agent-git/guard"
import { Schema, Effect } from "effect"
import { join } from "node:path"
import { HostStart } from "../agent-host/protocol"
import { CodexRetryTurn } from "./codex-retry"
import { constants } from "node:fs"
import { open, readFile, rename, stat, writeFile } from "node:fs/promises"
import { nativeSandboxArguments } from "../sandbox/native"
import { codexProjectArguments } from "../execution/project-config"
import { randomUUID } from "node:crypto"
import {
  claudeInteractiveArguments,
  runClaudeInteractiveTurn,
  type ClaudeSession,
} from "./claude-interactive"

export type CliWorkerOptions = {
  readonly binary: string
  readonly directory: string
  readonly promptFile: string
  readonly resultFile: string
  readonly eventsFile: string
  readonly stderrFile: string
  readonly maxOutputBytes: number
  readonly model: string | null
  readonly effort?: string
  readonly provider?: string
  readonly sandboxBindingFile?: string
}

const writeResult = async (path: string, exitCode: number) => {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ version: 1, exitCode })}\n`, {
    mode: 0o600,
    flag: "wx",
  })
  await rename(temporary, path)
}

const drainBounded = async (
  stream: ReadableStream<Uint8Array>,
  path: string,
  limit: number,
  observe?: (chunk: Uint8Array) => void,
) => {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  limit = Math.max(0, limit - (await file.stat()).size)
  const reader = stream.getReader()
  let written = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      observe?.(next.value)
      if (written >= limit) continue
      const chunk = next.value.subarray(0, limit - written)
      await file.write(chunk)
      written += chunk.byteLength
    }
  } finally {
    // This worker exclusively owns the stream and drains it to EOF. Bun 1.3.14
    // can throw while releasing an already-closed native reader; there is no
    // subsequent consumer that needs its lock. Always close the capture file.
    await file.close()
  }
}

/** Runs inside a transient user service and durably captures bounded output. */
export async function runCodexWorker(options: CliWorkerOptions): Promise<number> {
  return runCliWorker(
    options,
    [
      options.binary,
      "exec",
      "--json",
      ...codexProjectArguments(options.directory),
      ...(options.sandboxBindingFile === undefined
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : await nativeSandboxArguments(
            "codex",
            options.binary,
            options.directory,
            options.sandboxBindingFile,
          )),
      "--cd",
      options.directory,
      ...(options.model === null ? [] : ["-m", options.model]),
      ...(options.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`]),
      ...(options.provider === undefined
        ? []
        : ["-c", `model_provider=${JSON.stringify(options.provider)}`]),
      "-",
    ],
    true,
  )
}

/** Shared bounded capture for durable CLI processes. */
export async function runCliWorker(
  options: CliWorkerOptions,
  command: ReadonlyArray<string>,
  retryProvider = false,
): Promise<number> {
  const prompt = await readFile(options.promptFile)
  await writeFile(options.eventsFile, "", {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  })
  let args = [...command]
  for (let attempt = 0; ; attempt++) {
    await writeFile(options.stderrFile, "", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    const turn = new CodexRetryTurn()
    const child = Bun.spawn(args, {
      cwd: options.directory,
      env: process.env,
      stdin: attempt === 0 ? prompt : new TextEncoder().encode("Continue."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [status] = await Promise.all([
      child.exited,
      drainBounded(
        child.stdout,
        options.eventsFile,
        options.maxOutputBytes,
        retryProvider ? (bytes) => turn.chunk(bytes) : undefined,
      ),
      drainBounded(child.stderr, options.stderrFile, options.maxOutputBytes),
    ])
    const exitCode = typeof status === "number" ? status : -1
    const delay =
      retryProvider &&
      process.env.WORKFLOWD_AGENT_HOST_SOCKET === undefined &&
      exitCode === 1 &&
      (await stat(options.eventsFile)).size < options.maxOutputBytes
        ? turn.retryDelay(attempt)
        : undefined
    if (delay === undefined || turn.threadId === undefined) {
      await writeResult(options.resultFile, exitCode)
      return exitCode
    }
    await Bun.sleep(delay)
    args = [...command.slice(0, -1), "resume", turn.threadId, "-"]
  }
}

export const parseCodexWorkerArguments = (arguments_: ReadonlyArray<string>): CliWorkerOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("codex worker arguments must be --name value pairs")
    }
    values.set(name, value)
  }
  const required = (name: string) => {
    const value = values.get(name)
    if (value === undefined || value === "") throw new Error(`missing ${name}`)
    return value
  }
  return {
    binary: required("--binary"),
    directory: required("--directory"),
    promptFile: required("--prompt-file"),
    resultFile: required("--result-file"),
    eventsFile: required("--events-file"),
    stderrFile: required("--stderr-file"),
    maxOutputBytes: Number.parseInt(required("--max-output-bytes"), 10),
    model: values.get("--model") ?? null,
    ...(values.has("--effort") ? { effort: required("--effort") } : {}),
    ...(values.has("--provider") ? { provider: required("--provider") } : {}),
    ...(values.has("--sandbox-binding-file")
      ? { sandboxBindingFile: required("--sandbox-binding-file") }
      : {}),
  }
}

/** Durable worker files for one interactive Claude turn. A dispatched turn keeps the
 * stream-event contract from real transcript records; a resumed turn returns its answer. */
export async function runClaudeInteractiveWorker(
  options: CliWorkerOptions,
  session: ClaudeSession,
  timeoutMs?: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const prompt = await readFile(options.promptFile, "utf8")
  for (const path of [options.eventsFile, options.stderrFile])
    await writeFile(path, "", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
  const events = await open(
    options.eventsFile,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  )
  // Ordinary records leave room for a final failure record. Once a required record is
  // lost, no later result may report success.
  const reserve = Math.min(4096, options.maxOutputBytes)
  let written = 0
  let lost = false
  const emit = async (line: string, limit = options.maxOutputBytes - reserve) => {
    const bytes = Buffer.from(line + "\n")
    if (lost || written + bytes.length > limit) {
      lost = true
      return false
    }
    await writeAll(events, bytes)
    written += bytes.length
    return true
  }
  let outcome: Awaited<ReturnType<typeof runClaudeInteractiveTurn>>
  try {
    outcome = await runClaudeInteractiveTurn({
      args: await claudeInteractiveArguments(options, session),
      prompt,
      directory: options.directory,
      session: session.id,
      env,
      hooksPath: `${options.stderrFile}.hooks`,
      ...(timeoutMs === undefined ? {} : { deadline: Date.now() + timeoutMs }),
      ...(session.resume
        ? {}
        : {
            onStart: async (model) => {
              const init = { type: "system", subtype: "init", session_id: session.id }
              await emit(JSON.stringify(model === null ? init : { ...init, model }))
            },
            onRecord: async (line) => {
              await emit(line)
            },
          }),
    })
    if (lost) outcome = capacityFailure(outcome)
    const result = (value: typeof outcome) => ({
      type: "result",
      is_error: value.failure !== null,
      result: value.failure ?? value.text,
      session_id: session.id,
      usage: { output_tokens: value.outputTokens },
    })
    // The final record may use the reserve; an oversized answer becomes a failure.
    lost = false
    if (!(await emit(JSON.stringify(result(outcome)), options.maxOutputBytes))) {
      lost = false
      outcome = capacityFailure(outcome)
      await emit(JSON.stringify(result(outcome)), options.maxOutputBytes)
    }
  } catch (error) {
    // No result is published for unconfirmed custody; keep its reason privately.
    await events.close().catch(() => undefined)
    await writeFile(
      options.stderrFile,
      Buffer.from(error instanceof Error ? error.message : String(error)).subarray(
        0,
        options.maxOutputBytes,
      ),
      { mode: 0o600, flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW },
    ).catch(() => undefined)
    throw error
  }
  await events.close()
  if (outcome.failure !== null)
    await writeFile(
      options.stderrFile,
      Buffer.from(`${outcome.failure}\n${outcome.diagnostic}`).subarray(0, options.maxOutputBytes),
      {
        mode: 0o600,
        flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      },
    )
  await writeResult(options.resultFile, outcome.exitCode)
  return outcome.exitCode
}

const capacityFailure = <T extends { readonly exitCode: number }>(outcome: T) => ({
  ...outcome,
  exitCode: outcome.exitCode === 0 ? 1 : outcome.exitCode,
  completed: false,
  failure: "Claude output capacity",
})

/** FileHandle writes may be partial; every byte is written or the write fails. */
async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; ) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset)
    if (bytesWritten <= 0) throw new Error("Claude output write made no progress")
    offset += bytesWritten
  }
}

/** Claude Code uses its own local subscription credentials and persisted sessions. */
export const runClaudeNativeWorker = (options: CliWorkerOptions): Promise<number> =>
  runClaudeInteractiveWorker(options, { id: randomUUID(), resume: false })

/** Own the input/output files without launching the selected native adapter. */
export async function prepareHostWorker(inputPath: string, binary: string, io = process.cwd()) {
  // systemd selects the private I/O directory; argv cannot select another file tree.
  const input = join(io, "input")
  if (inputPath !== input) throw new Error("invalid host input path")
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const HostInput = Schema.Struct({
    ...HostStart.fields,
    git: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String,
        email: Schema.String,
        blockedEmails: Schema.Array(Schema.String),
      }),
    ),
  })
  let request: typeof HostInput.Type
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error("invalid host input file")
    request = Schema.decodeUnknownSync(HostInput)(JSON.parse(await file.readFile("utf8")))
  } finally {
    await file.close()
  }
  // A host launch owns a fresh directory. Never reuse agent-supplied output links.
  for (const name of ["prompt", "events", "stderr", "result"]) {
    const output = await open(join(io, name), "wx", 0o600)
    await output.close()
  }
  const prompt = join(io, "prompt")
  await writeFile(prompt, request.prompt, {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  })
  const options: CliWorkerOptions = {
    binary,
    directory: request.directory,
    promptFile: prompt,
    resultFile: join(io, "result"),
    eventsFile: join(io, "events"),
    stderrFile: join(io, "stderr"),
    maxOutputBytes: 10 * 1024 * 1024,
    model: request.model,
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.provider === undefined ? {} : { provider: request.provider }),
  }
  return { request, options }
}

export async function runHostWorker(inputPath: string, binary: string, io = process.cwd()) {
  const { request, options } = await prepareHostWorker(inputPath, binary, io)
  if (request.profile === "workspace") {
    const { runWorkspaceCommand } = await import("../workspace/command")
    if (
      !request.repository ||
      !request.branch ||
      request.branch.startsWith("-") ||
      request.base?.startsWith("-")
    )
      throw new Error("invalid workspace selection")
    const existing = await stat(request.directory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error
    })
    if (existing && !existing.isDirectory()) throw new Error("workspace is not a directory")
    if (!existing) {
      await Effect.runPromise(
        runWorkspaceCommand("clone agent repository", [
          "/usr/bin/git",
          "-c",
          "core.hooksPath=/dev/null",
          "clone",
          "--no-local",
          "--no-hardlinks",
          "--no-checkout",
          "--",
          request.repository,
          request.directory,
        ]),
      )
      await Effect.runPromise(
        runWorkspaceCommand("checkout agent branch", [
          "/usr/bin/git",
          "-C",
          request.directory,
          "-c",
          "core.hooksPath=/dev/null",
          "checkout",
          "-B",
          request.branch,
          request.base ?? "origin/HEAD",
        ]),
      )
    }
    await Effect.runPromise(installAgentGitGuard(request.directory, request.git))
    await writeFile(options.eventsFile, "", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await writeFile(options.stderrFile, "", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await writeResult(options.resultFile, 0)
    return 0
  }
  await Effect.runPromise(refreshAgentGitGuard(request.directory, request.git))
  if (request.profile === "codex-server")
    return runCliWorker(options, [
      binary,
      "app-server",
      ...codexProjectArguments(request.directory),
      "--listen",
      `unix://${join(io, "rpc.sock")}`,
    ])
  if (request.profile === "codex") return runCodexWorker(options)
  if (request.profile === "claude") return runClaudeNativeWorker(options)
  if (request.profile === "claude-session") {
    const { makeClaudeCli } = await import("./claude-session")
    const exists = await Effect.runPromise(
      makeClaudeCli({ binary }).sessionExists({
        nativeSessionId: request.nativeSessionId!,
        directory: request.directory,
      }),
    )
    await writeFile(options.eventsFile, JSON.stringify(exists), {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await writeFile(options.stderrFile, "", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await writeResult(options.resultFile, 0)
    return 0
  }
  if (request.profile === "claude-resume")
    return runClaudeInteractiveWorker(
      { ...options, model: null },
      { id: request.nativeSessionId!, resume: true },
      request.timeoutMs,
    )
  if (request.profile === "codex-discovery") {
    const { makeCodexDiscovery } = await import("../execution/codex")
    const models = await makeCodexDiscovery("codex:local", {
      command: [
        binary,
        "app-server",
        ...codexProjectArguments(request.directory),
        "--listen",
        "stdio://",
      ],
    }).discover(AbortSignal.timeout(30000))
    await writeFile(options.eventsFile, JSON.stringify(models) + "\n", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await writeFile(options.stderrFile, "", {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await writeResult(options.resultFile, 0)
    return 0
  }
  const { runWorkspaceCommand } = await import("../workspace/command")
  await Effect.runPromise(runWorkspaceCommand("host native version", [binary, "--version"]))
  const output = await Effect.runPromise(
    runWorkspaceCommand(
      "host native authentication",
      request.profile === "codex-preflight"
        ? [binary, "login", "status"]
        : [binary, "auth", "status"],
    ),
  )
  if (
    request.profile === "claude-preflight" &&
    !Schema.decodeUnknownSync(Schema.Struct({ loggedIn: Schema.Boolean }))(JSON.parse(output))
      .loggedIn
  )
    throw new Error("native authentication unavailable")
  await writeFile(options.eventsFile, "", {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  })
  await writeFile(options.stderrFile, "", {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  })
  await writeResult(options.resultFile, 0)
  return 0
}

if (import.meta.main) {
  try {
    const exitCode =
      process.argv[2] === "--host-input"
        ? await runHostWorker(process.argv[3]!, process.argv[5]!)
        : await runCodexWorker(parseCodexWorkerArguments(process.argv.slice(2)))
    process.exitCode = exitCode < 0 ? 1 : exitCode
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}

export type CodexWorkerOptions = CliWorkerOptions
