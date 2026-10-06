import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, open, rename, link, rm } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import artifact from "../../deploy/opencode/sandbox.json"
import { SandboxTransport } from "./transport"

export const sandboxRules = artifact.agents.sandbox.permissions
export const sandboxPolicyHash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex")
export const bindingDirectory = (directory: string) => `${directory}.sandbox`
export const transportHash = (transport: SandboxTransport) =>
  createHash("sha256")
    .update(JSON.stringify(Schema.decodeUnknownSync(SandboxTransport)(transport)))
    .digest("hex")

export const SandboxSessionBinding = Schema.Struct({
  runId: Schema.NonEmptyString,
  leaseId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  sessionId: Schema.String.check(Schema.isPattern(/^ses_[a-zA-Z0-9]+$/)),
  executorId: Schema.NonEmptyString,
  endpointIdentity: Schema.NonEmptyString,
  directory: Schema.String.check(Schema.isPattern(/^\/[a-zA-Z0-9/_.@-]+$/)),
  locationIdentity: Schema.NonEmptyString,
  bridgeServerName: Schema.String.check(Schema.isPattern(/^workflowd_sandbox_[a-zA-Z0-9_]+$/)),
  repositoryId: Schema.Int.check(Schema.isGreaterThan(0)),
  sourceSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  policyHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  transportHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  deadline: Schema.Number,
  state: Schema.Literals(["reserved", "active", "revoked"]),
})
export type SandboxSessionBinding = typeof SandboxSessionBinding.Type

export async function readSandboxBinding(directory: string) {
  const binding = Schema.decodeUnknownSync(SandboxSessionBinding)(
    JSON.parse(await readFile(join(bindingDirectory(directory), "binding.json"), "utf8")),
  )
  if (binding.directory !== directory || (await realpath(directory)) !== directory)
    throw new Error("Sandbox binding location changed")
  return binding
}

export async function writeSandboxBinding(binding: SandboxSessionBinding, reserve = false) {
  Schema.decodeUnknownSync(SandboxSessionBinding)(binding)
  const root = bindingDirectory(binding.directory)
  if (reserve) await mkdir(root, { mode: 0o700 })
  else {
    const saved = await readSandboxBinding(binding.directory)
    if (
      JSON.stringify({ ...saved, state: binding.state }) !== JSON.stringify(binding) ||
      (saved.state === "revoked" && binding.state !== "revoked")
    )
      throw new Error("Sandbox binding is immutable or revoked")
  }
  await saveSandboxFile(root, "binding.json", JSON.stringify(binding))
}

export async function assertBridgeBinding(file: string, transport: SandboxTransport) {
  const binding = Schema.decodeUnknownSync(SandboxSessionBinding)(
    JSON.parse(await readFile(file, "utf8")),
  )
  if (
    file !== join(bindingDirectory(binding.directory), "binding.json") ||
    binding.state !== "active" ||
    binding.leaseId !== transport.leaseId ||
    binding.transportHash !== transportHash(transport) ||
    binding.deadline <= Date.now()
  )
    throw new Error("Sandbox bridge is revoked or has a different transport")
}

export async function saveSandboxFile(
  directory: string,
  name: string,
  value: string | Uint8Array,
  exclusive = false,
) {
  const temporary = join(directory, `${name}-${randomBytes(8).toString("hex")}`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(value)
    await file.sync()
  } finally {
    await file.close()
  }
  if (exclusive) {
    try {
      await link(temporary, join(directory, name))
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error
    } finally {
      await rm(temporary, { force: true })
    }
  } else await rename(temporary, join(directory, name))
  const parent = await open(directory, "r")
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}
