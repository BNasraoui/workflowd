import { CodexRetryTurn } from "./codex-retry"
import { open, readFile, rename, stat, writeFile } from "node:fs/promises"
import { nativeSandboxArguments } from "../sandbox/native"
import { codexProjectArguments } from "../execution/project-config"

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
  await writeFile(temporary, `${JSON.stringify({ version: 1, exitCode })}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const drainBounded = async (
  stream: ReadableStream<Uint8Array>,
  path: string,
  limit: number,
  observe?: (chunk: Uint8Array) => void,
) => {
  const file = await open(path, "a", 0o600)
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
    reader.releaseLock()
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
  await writeFile(options.eventsFile, "", { mode: 0o600 })
  let args = [...command]
  for (let attempt = 0; ; attempt++) {
    await writeFile(options.stderrFile, "", { mode: 0o600 })
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

if (import.meta.main) {
  try {
    const exitCode = await runCodexWorker(parseCodexWorkerArguments(process.argv.slice(2)))
    process.exitCode = exitCode < 0 ? 1 : exitCode
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}

export type CodexWorkerOptions = CliWorkerOptions
