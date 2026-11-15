import { spawn } from "node:child_process"
import { publicBootstrapConfiguration, serializePublicStatus } from "./public-status.mjs"

if (import.meta.main) {
  let stage = process.argv[2]
  try {
    serializePublicStatus({ stage, outcome: "ok", reason: "none" })
    if (process.argv[3] !== "--" || !process.argv[4]) throw new Error()
    if (process.env.SANDBOX_TAILSCALE_CLIENT_ID !== undefined)
      publicBootstrapConfiguration({
        tailscaleClientId: process.env.SANDBOX_TAILSCALE_CLIENT_ID,
        tailscaleAudience: process.env.SANDBOX_AUDIENCE,
      })
    const environment = { ...process.env }
    for (const key of [
      "GITHUB_OUTPUT",
      "GITHUB_STEP_SUMMARY",
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_STATE",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BASHOPTS",
    ])
      delete environment[key]
    const child = spawn(process.argv[4], process.argv.slice(5), {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    let size = 0
    let reason = "none"
    let pending = ""
    let cancelled = false
    const stop = (why) => {
      reason = why
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }
    const timer = setTimeout(() => stop("timeout"), stage === "audit" ? 285 * 60000 : 300000)
    const consume = (bytes, audit = false) => {
      size += bytes.length
      if (size > 4 * 1048576) {
        stop("capacity")
        return
      }
      if (!audit) return
      pending += bytes.toString("utf8")
      if (pending.length > 8192) {
        stop("capacity")
        return
      }
      let at
      while ((at = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        try {
          if (!line.startsWith("workflowd.audit ")) continue
          const record = JSON.parse(line.slice("workflowd.audit ".length))
          process.stdout.write(
            serializePublicStatus({
              stage: "audit",
              outcome: record.outcome === "ok" ? "ok" : "failed",
              reason: record.outcome === "ok" ? "none" : "unavailable",
              count: record.sequence,
            }) + "\n",
          )
        } catch {
          stop("refused")
        }
      }
    }
    child.stdout.on("data", (bytes) => consume(bytes, stage === "audit"))
    child.stderr.on("data", (bytes) => consume(bytes))
    child.once("error", () => {
      reason = "unavailable"
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      // The hold of a session names why the relay ended it.
      const ended = { 3: "renewal", 4: "expiry", 5: "deadline" }[code]
      if (stage === "audit" && ended && reason === "none") reason = ended
      // The child's own output is counted and dropped: only this status line is public.
      const receipt = serializePublicStatus({
        stage,
        outcome: cancelled ? "cancelled" : code === 0 && reason === "none" ? "ok" : "failed",
        reason:
          code === 0 && reason === "none" ? "none" : reason === "none" ? "unavailable" : reason,
      })
      process.stdout.write(receipt + "\n")
      process.exitCode = code === 0 && reason === "none" ? 0 : 1
    })
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        cancelled = true
        stop("unavailable")
      })
  } catch {
    stage = ["setup", "bootstrap", "audit", "transport", "cleanup", "test"].includes(stage)
      ? stage
      : "setup"
    process.stdout.write(
      serializePublicStatus({ stage, outcome: "failed", reason: "refused" }) + "\n",
    )
    process.exitCode = 1
  }
}
