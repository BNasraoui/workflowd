import { parseCodexWorkerArguments, runClaudeNativeWorker } from "./codex-worker"

export const runClaudeWorker = runClaudeNativeWorker

export async function runClaudeWorkerMain(arguments_: ReadonlyArray<string>): Promise<number> {
  try {
    const exitCode = await runClaudeWorker(parseCodexWorkerArguments(arguments_))
    return exitCode < 0 ? 1 : exitCode
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    return 1
  }
}

if (import.meta.main) process.exitCode = await runClaudeWorkerMain(process.argv.slice(2))
