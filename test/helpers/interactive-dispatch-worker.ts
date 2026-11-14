import { parseCodexWorkerArguments } from "../../src/kernel/codex-worker"
import { runInteractiveWorker } from "./interactive-worker"

const baseUrl = process.env.WORKFLOWD_FIXTURE_UPSTREAM
if (!baseUrl || new URL(baseUrl).hostname !== "127.0.0.1")
  throw new Error("Interactive fixture requires its isolated loopback upstream")
process.exitCode = await runInteractiveWorker(
  parseCodexWorkerArguments(process.argv.slice(2)),
  baseUrl,
)
