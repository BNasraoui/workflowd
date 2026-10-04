import { open, readFile, rename, writeFile } from "node:fs/promises"

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
  readonly serviceTier?: string | null
}

const writeResult = async (path: string, exitCode: number) => {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ version: 1, exitCode })}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const drainBounded = async (stream: ReadableStream<Uint8Array>, path: string, limit: number) => {
  const file = await open(path, "w", 0o600)
  const reader = stream.getReader()
  let written = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
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
  return runCliWorker(options, [
    options.binary,
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--cd",
    options.directory,
    ...(options.model === null ? [] : ["-m", options.model]),
    ...(options.effort === undefined
      ? []
      : ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`]),
    ...(options.provider === undefined
      ? []
      : ["-c", `model_provider=${JSON.stringify(options.provider)}`]),
    ...(options.serviceTier === undefined
      ? []
      : [
          "-c",
          `service_tier=${JSON.stringify(options.serviceTier === "priority" ? "fast" : (options.serviceTier ?? "default"))}`,
        ]),
    "-",
  ])
}

/** Shared bounded capture for durable CLI processes. */
export async function runCliWorker(
  options: CliWorkerOptions,
  command: ReadonlyArray<string>,
): Promise<number> {
  const prompt = await readFile(options.promptFile)
  const child = Bun.spawn([...command], {
    cwd: options.directory,
    env: process.env,
    stdin: prompt,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status] = await Promise.all([
    child.exited,
    drainBounded(child.stdout, options.eventsFile, options.maxOutputBytes),
    drainBounded(child.stderr, options.stderrFile, options.maxOutputBytes),
  ])
  const exitCode = typeof status === "number" ? status : -1
  await writeResult(options.resultFile, exitCode)
  return exitCode
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
    ...(values.has("--service-tier")
      ? {
          serviceTier:
            required("--service-tier") === "standard" ? null : required("--service-tier"),
        }
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
