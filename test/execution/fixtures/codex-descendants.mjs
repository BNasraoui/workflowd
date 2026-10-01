import { appendFileSync, writeFileSync, existsSync, watch } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"

export function runHangingCodex(directory) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  })
  appendFileSync(
    join(directory, "pids.jsonl"),
    JSON.stringify([process.pid, descendant.pid]) + "\n",
  )
  createInterface({ input: process.stdin }).on("line", (line) => {
    const frame = JSON.parse(line)
    if (frame.method === "initialized") return
    if (frame.method === "model/list") {
      const respond = () => {
        if (!existsSync(join(directory, "release"))) return
        watcher.close()
        process.stdout.write(
          JSON.stringify({ id: frame.id, result: { data: [], nextCursor: null } }) + "\n",
        )
      }
      const watcher = watch(directory, respond)
      writeFileSync(join(directory, "ready"), "ready")
      respond()
      return
    }
    const result =
      frame.method === "initialize"
        ? { userAgent: "fixture" }
        : frame.method === "config/read"
          ? { config: { model_provider: null } }
          : { account: { type: "apiKey" }, requiresOpenaiAuth: true }
    process.stdout.write(JSON.stringify({ id: frame.id, result }) + "\n")
  })
}
