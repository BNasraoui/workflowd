#!/usr/bin/env bun
import { lstat, readFile } from "node:fs/promises"
import { Schema } from "effect"
import { CredentialPolicy } from "../../src/agent-host/config"
import { relinkCredentials } from "../../src/agent-host/credential-relink"
import { credentialReason } from "../../src/agent-host/protocol"

try {
  const args = process.argv.slice(2)
  if (process.getuid?.() !== 0 || args.length !== 4 || args[0] !== "--client" || !["codex", "claude"].includes(args[1] ?? "") || args[2] !== "--source" || !["ben", "agent"].includes(args[3] ?? "")) throw new Error("invalid invocation")
  const path = "/etc/workflowd/agent-host.json"
  const info = await lstat(path)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("unsafe policy")
  const policy = Schema.decodeUnknownSync(CredentialPolicy)(JSON.parse(await readFile(path, "utf8")))
  if (policy.ownerUid !== 0 || policy.agentUid === 0 || policy.controllerUid === policy.agentUid) throw new Error("invalid identity")
  await relinkCredentials(policy, args[1] === "codex" ? "codex" : "claude", args[3] === "ben" ? "ben" : "agent")
  console.log("credential_relink_complete")
} catch (error) {
  console.error(credentialReason(error) ?? "credential_relink_refused")
  process.exitCode = 1
}
