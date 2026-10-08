import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, open, rename, link, rm } from "node:fs/promises"
import { join, normalize } from "node:path"
import { Schema } from "effect"
import artifact from "../../deploy/opencode/sandbox.json"
import { SandboxTransport } from "./transport"

export const sandboxRules = artifact.agents.sandbox.permissions
export const sandboxPolicyHash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex")
export const bindingDirectory = (directory: string) => `${directory}.sandbox`
// Keep the lease namespace within the executor's tool-name limit. The full lease
// identity remains in the immutable binding; location isolation is unchanged.
export const sandboxBridgeName = (leaseId: string) =>
  `wfdlease_${createHash("sha256").update(leaseId).digest("hex").slice(0, 40)}`
// MCP permission actions flatten server and tool names with underscore normalization.
export const isSandboxBridgeNamespace = (server: string) =>
  `${server.replace(/[^a-zA-Z0-9_]/g, "_")}_`.startsWith("wfdlease_")
export const transportHash = (transport: SandboxTransport) =>
  createHash("sha256")
    .update(JSON.stringify(Schema.decodeUnknownSync(SandboxTransport)(transport)))
    .digest("hex")

export const SandboxSessionBinding = Schema.Struct({
  runId: Schema.NonEmptyString,
  leaseId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  sessionId: Schema.String.check(
    Schema.isPattern(/^(?:ses_[a-zA-Z0-9]+|[a-zA-Z0-9_-]{1,100}[a-f0-9]{24}\.service)$/),
  ),
  executorId: Schema.NonEmptyString,
  endpointIdentity: Schema.NonEmptyString,
  directory: Schema.String.check(Schema.isPattern(/^\/[a-zA-Z0-9/_.@-]+$/)),
  locationIdentity: Schema.NonEmptyString,
  bridgeServerName: Schema.String.check(Schema.isPattern(/^wfdlease_[a-zA-Z0-9_]+$/)),
  repositoryId: Schema.Int.check(Schema.isGreaterThan(0)),
  sourceSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  policyHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  transportHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  deadline: Schema.Number,
  state: Schema.Literals(["reserved", "active", "revoked"]),
})
export type SandboxSessionBinding = typeof SandboxSessionBinding.Type

export async function readSandboxBinding(directory: string) {
  if (
    !/^\/[a-zA-Z0-9/_.@-]+$/.test(directory) ||
    normalize(directory) !== directory ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Sandbox binding location is invalid")
  const file = join(bindingDirectory(directory), "binding.json")
  if ((await realpath(file)) !== file) throw new Error("Sandbox binding path is not canonical")
  const binding = Schema.decodeUnknownSync(SandboxSessionBinding)(
    JSON.parse(await readFile(file, "utf8")),
  )
  if (binding.directory !== directory) throw new Error("Sandbox binding location changed")
  // A separate durable tombstone wins even over an already in-flight active-file rename.
  if (await Bun.file(join(bindingDirectory(directory), "revoked")).exists())
    return { ...binding, state: "revoked" as const }
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
  if (binding.state === "revoked") await saveSandboxFile(root, "revoked", "", true)
  await saveSandboxFile(root, "binding.json", JSON.stringify(binding))
}

export async function assertBridgeBinding(file: string, transport: SandboxTransport) {
  const suffix = ".sandbox/binding.json"
  if (
    !/^\/[a-zA-Z0-9/_.@-]+\.sandbox\/binding\.json$/.test(file) ||
    normalize(file) !== file ||
    !file.endsWith(suffix)
  )
    throw new Error("Sandbox binding path is invalid")
  const directory = file.slice(0, -suffix.length)
  if (file !== join(bindingDirectory(directory), "binding.json") || (await realpath(file)) !== file)
    throw new Error("Sandbox binding path is not canonical")
  const binding = await readSandboxBinding(directory)
  if (
    binding.state !== "active" ||
    binding.leaseId !== transport.leaseId ||
    binding.transportHash !== transportHash(transport) ||
    binding.deadline <= Date.now()
  )
    throw new Error("Sandbox bridge is revoked or has a different transport")
  return binding
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
  let created = true
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
      created = false
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
  return created
}
