import { parseCodexWorkerArguments, runCliWorker, type CodexWorkerOptions } from "./codex-worker"

/** Claude Code uses its own local subscription credentials and persisted sessions. */
export const runClaudeWorker = (options: CodexWorkerOptions): Promise<number> =>
  runCliWorker(options, [
    options.binary,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    ...(options.model === null ? [] : ["--model", options.model]),
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
