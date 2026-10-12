import { parseCodexWorkerArguments, runCliWorker, type CliWorkerOptions } from "./codex-worker"
import { nativeSandboxArguments } from "../sandbox/native"

/** Claude Code uses its own local subscription credentials and persisted sessions. */
export const runClaudeWorker = async (options: CliWorkerOptions): Promise<number> =>
  runCliWorker(options, [
    options.binary,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(options.sandboxBindingFile === undefined
      ? ["--dangerously-skip-permissions"]
      : await nativeSandboxArguments(
          "claude",
          options.binary,
          options.directory,
          options.sandboxBindingFile,
        )),
    ...(options.model === null ? [] : ["--model", options.model]),
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
  ])

if (import.meta.main) {
  try {
    const exitCode = await runClaudeWorker(parseCodexWorkerArguments(process.argv.slice(2)))
    process.exitCode = exitCode < 0 ? 1 : exitCode
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
