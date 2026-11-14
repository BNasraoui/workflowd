import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Ben-approved v2 addendum (review 01a18ac2-d32b-7362-b43a-c0aad6ce2c74).
// Only trusted administrator configuration may reach these two public fields.
export const publicBootstrapFields = {
  tailscaleClientId: /^[A-Za-z0-9_-]{1,128}$/,
  tailscaleAudience: /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/,
}
export function publicBootstrapConfiguration(input) {
  const output = {}
  for (const [field, pattern] of Object.entries(publicBootstrapFields)) {
    if (typeof input[field] !== "string" || !pattern.test(input[field]))
      throw new Error("bootstrap configuration refused")
    output[field] = input[field]
  }
  return output
}

/** Controlled public sinks accept metadata, never arbitrary diagnostic text. */
export function serializePublicStatus(input) {
  const { stage, outcome, reason, count = 0 } = input
  if (
    !["setup", "bootstrap", "audit", "transport", "cleanup", "test"].includes(stage) ||
    !["ok", "failed", "cancelled"].includes(outcome) ||
    !["none", "refused", "unavailable", "timeout", "capacity"].includes(reason) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 1000000000
  )
    throw new Error("public status refused")
  return JSON.stringify({ version: 1, stage, outcome, reason, count, correlationId: randomUUID() })
}

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
    const directory = mkdtempSync(join(tmpdir(), "workflowd-private-"))
    const captured = []
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
      captured.push(bytes)
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
      // Join before filtering, so chunk boundaries cannot expose known job
      // credentials. Upstream credentials are never present on this runner.
      let diagnostic = Buffer.concat(captured).toString("utf8")
      for (const [key, value] of Object.entries(process.env)) {
        if (!/(?:TOKEN|SECRET|PASSWORD|KEY)$/.test(key) || !value) continue
        for (const form of new Set([
          value,
          Buffer.from(value).toString("base64"),
          Buffer.from(value).toString("base64url"),
          Buffer.from(value).toString("hex"),
          encodeURIComponent(value),
        ]))
          diagnostic = diagnostic.replaceAll(form, "[credential excluded]")
      }
      try {
        writeFileSync(join(directory, "capture.log"), diagnostic, { mode: 0o600, flag: "wx" })
      } catch {
        reason = "unavailable"
      }
      let receipt = serializePublicStatus({
        stage,
        outcome: cancelled ? "cancelled" : code === 0 && reason === "none" ? "ok" : "failed",
        reason:
          code === 0 && reason === "none" ? "none" : reason === "none" ? "unavailable" : reason,
      })
      try {
        writeFileSync(join(directory, "receipt.json"), receipt, { mode: 0o600 })
      } catch {
        reason = "unavailable"
        receipt = serializePublicStatus({ stage, outcome: "failed", reason })
      }
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
