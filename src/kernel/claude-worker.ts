import { parseCodexWorkerArguments, runClaudeNativeWorker } from "./codex-worker"

export const runClaudeWorker = runClaudeNativeWorker

if (import.meta.main) {
  try {
    const exitCode = await runClaudeWorker(parseCodexWorkerArguments(process.argv.slice(2)))
    process.exitCode = exitCode < 0 ? 1 : exitCode
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
