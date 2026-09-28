import { readFile, rename, writeFile } from "node:fs/promises"

export type CodexWorkerOptions = {
  readonly binary: string
  readonly directory: string
  readonly promptFile: string
  readonly resultFile: string
  readonly model: string | null
}

const writeResult = async (path: string, exitCode: number) => {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ version: 1, exitCode })}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Runs inside a transient user service. Systemd owns stdout/stderr and
 * appends both streams to the custody paths configured by the launcher. */
export async function runCodexWorker(options: CodexWorkerOptions): Promise<number> {
  const prompt = await readFile(options.promptFile)
  const child = Bun.spawn(
    [
      options.binary,
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd",
      options.directory,
      ...(options.model === null ? [] : ["-m", options.model]),
      "-",
    ],
    {
      cwd: options.directory,
      env: process.env,
      stdin: prompt,
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const status = await child.exited
  const exitCode = typeof status === "number" ? status : -1
  await writeResult(options.resultFile, exitCode)
  return exitCode
}

const parseArguments = (arguments_: ReadonlyArray<string>): CodexWorkerOptions => {
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
    model: values.get("--model") ?? null,
  }
}

if (import.meta.main) {
  try {
    const exitCode = await runCodexWorker(parseArguments(process.argv.slice(2)))
    process.exitCode = exitCode < 0 ? 1 : exitCode
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
