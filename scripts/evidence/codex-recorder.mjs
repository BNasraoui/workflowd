#!/usr/bin/env bun
// Transparent stdio recorder: responses always come from the real Codex binary.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"
import { join } from "node:path"

const root = process.env.EVIDENCE_ROOT
if (!root || !process.env.EVIDENCE_CODEX_BIN) throw new Error("Evidence environment required")
const secrets = JSON.parse(readFileSync(join(root, "redactions.json"), "utf8"))
const scrub = (text) =>
  secrets.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text)
const record = (direction, frame) =>
  appendFileSync(
    join(root, "logs", "codex.jsonl"),
    scrub(
      JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        runId: process.env.WORKFLOWD_RUN_ID ?? null,
        direction,
        frame,
      }),
    ) + "\n",
  )
const args = process.argv.slice(2)
const birth = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19]
record("launch", { args, birth })
const child = spawn(process.env.EVIDENCE_CODEX_BIN, args, {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
})
const stop = () => {
  if (child.exitCode === null) child.kill("SIGTERM")
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
// Capture only protocol frames and diagnostics; never inspect inherited credentials.
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    record("receive", JSON.parse(line))
  } catch {
    record("stdout", { text: line })
  }
  process.stdout.write(line + "\n")
})
createInterface({ input: child.stderr }).on("line", (line) => {
  record("stderr", { text: line })
  process.stderr.write(scrub(line) + "\n")
})
createInterface({ input: process.stdin })
  .on("line", (line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      /* exec receives a plain prompt */
    }
    if (frame) record("send", frame)
    if (
      frame?.method === "thread/queue/add" &&
      !frame.params.clientUserMessageId.startsWith("dispatch:")
    ) {
      const marker = join(root, `fail-${process.env.WORKFLOWD_RUN_ID}`)
      if (existsSync(marker)) {
        record("fault", { reason: "stop owned app-server before mailbox queue call" })
        writeFileSync(marker + ".observed", "stopped")
        stop()
        return
      }
    }
    child.stdin.write(line + "\n")
  })
  .on("close", () => child.stdin.end())
child.on("exit", (code) => {
  record("exit", { code })
  process.exit(code ?? 1)
})
child.on("error", (error) => {
  record("exit", { error: "could not spawn Codex", code: error.code })
  process.exit(1)
})
