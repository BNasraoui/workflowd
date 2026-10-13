#!/usr/bin/env bun
import { lstat, readFile } from "node:fs/promises"
import { Schema } from "effect"
import { CredentialPolicy } from "../../src/agent-host/config"
import { credentialLock } from "../../src/agent-host/credentials"
import { migrateOpenCodeGrants, type OpenCodeMigrationPolicy } from "../../src/agent-host/opencode-credentials"

async function systemctl(args: readonly string[]) {
  const command = Bun.spawn(["/usr/bin/systemctl", ...args], { stdout: "pipe", stderr: "ignore" })
  const stdout = (await new Response(command.stdout).text()).trim()
  return { stdout, exitCode: await command.exited }
}

export async function migrateConfiguredOpenCode(
  policy: OpenCodeMigrationPolicy,
  inspectUnit: (args: readonly string[]) => Promise<{ stdout: string; exitCode: number }> = systemctl,
) {
  if (policy.sourceUnits.length === 0) throw new Error("source units not configured")
  for (const unit of policy.sourceUnits) {
    if (unit.scope === "user" && !unit.user) throw new Error("source unit user not configured")
    const scope = unit.scope === "user" ? ["--user", "-M", `${unit.user}@`] : []
    const enabled = await inspectUnit([...scope, "is-enabled", unit.name])
    const active = await inspectUnit([...scope, "is-active", unit.name])
    if (enabled.stdout !== "masked" || enabled.exitCode !== 1 ||
      active.stdout !== "inactive" || active.exitCode !== 3)
      throw new Error("source server must be masked and stopped")
  }
  await migrateOpenCodeGrants(policy)
}

if (import.meta.main) {
  try {
    if (process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error("invalid invocation")
    const path = "/etc/workflowd/agent-host.json"
    const info = await lstat(path)
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("unsafe policy")
    const policy = Schema.decodeUnknownSync(CredentialPolicy)(JSON.parse(await readFile(path, "utf8")))
    if (policy.ownerUid !== 0 || !policy.opencode || policy.agentUid === 0 || policy.agentUid === policy.controllerUid || policy.opencode.agentUid !== policy.agentUid)
      throw new Error("migration not configured")
    const release = await credentialLock(policy, true)
    try { await migrateConfiguredOpenCode(policy.opencode) } finally { await release() }
    console.log("opencode_grant_migration_complete")
  } catch {
    console.error("opencode_grant_migration_incomplete")
    process.exitCode = 1
  }
}
