#!/usr/bin/env bun
import { lstat, readFile } from "node:fs/promises"
import { Schema } from "effect"
import { CredentialPolicy } from "../../src/agent-host/config"
import { credentialLock } from "../../src/agent-host/credentials"
import { migrateOpenCodeGrants } from "../../src/agent-host/opencode-credentials"

try {
  if (process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error("invalid invocation")
  const path = "/etc/workflowd/agent-host.json"
  const info = await lstat(path)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("unsafe policy")
  const policy = Schema.decodeUnknownSync(CredentialPolicy)(JSON.parse(await readFile(path, "utf8")))
  if (policy.ownerUid !== 0 || !policy.opencode) throw new Error("migration not configured")
  // The old server must be administratively disabled before grants can move.
  const old = Bun.spawn(["systemctl", "is-enabled", "workflowd-opencode-controller.service"], { stdout: "pipe", stderr: "ignore" })
  const status = (await new Response(old.stdout).text()).trim()
  await old.exited
  if (status !== "masked") throw new Error("source server not masked")
  const release = await credentialLock(policy, true)
  try { await migrateOpenCodeGrants(policy.opencode) } finally { await release() }
  console.log("opencode_grant_migration_complete")
} catch {
  console.error("opencode_grant_migration_incomplete")
  process.exitCode = 1
}
