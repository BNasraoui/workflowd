import { readFile, rename, open, lstat } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"

const digest = bytes => createHash("sha256").update(bytes).digest("hex")
async function boundedFile(path, limit) {
  const info = await lstat(path)
  if (!info.isFile() || info.size > limit) throw new Error("Capture receipt capacity")
  return readFile(path)
}
async function sync(path) {
  const file = await open(path, "r")
  try { await file.sync() } finally { await file.close() }
}
async function save(path, data) {
  const file = await open(path, "wx", 0o600)
  try { await file.writeFile(data); await file.sync() } finally { await file.close() }
}

/** Offline result capture, after exact invocation/container shutdown. */
export async function captureNativeResult({ root, directory, invocation, request, backend, command, tooling }) {
  if (invocation.state !== "stopped" || invocation.outcome !== "completed" ||
      Object.keys(request).sort().join() !== "completion,nonce,session" ||
      request.nonce !== invocation.nonce || request.session !== invocation.session)
    throw new Error("Capture custody refused")
  const source = (await boundedFile(join(root, "source.sha"), 41)).toString("utf8").trim()
  const completion = request.completion
  if (!/^[a-f0-9]{40}$/.test(source) || !completion ||
      Object.keys(completion).sort().join() !== "body,branch,commitMessage,title" ||
      Object.values(completion).some(value => typeof value !== "string"))
    throw new Error("Capture metadata refused")
  const requestDigest = digest(JSON.stringify([source, request.nonce, request.session,
    completion.branch, completion.title, completion.commitMessage, completion.body]))
  const verify = async metadata => {
    const value = JSON.parse(metadata)
    if (value.sourceSha !== source) throw new Error("Capture source mismatch")
    if (value.empty === true) return
    if (Object.entries(completion).some(([key, expected]) => value[key] !== expected))
      throw new Error("Capture candidate mismatch")
    const manifest = await boundedFile(join(root, "result/result.json"), 262144)
    const bundle = await boundedFile(join(root, "result/result.bundle"), 16 * 1048576)
    if (digest(manifest) !== value.manifestSha256 || digest(bundle) !== value.bundleSha256)
      throw new Error("Capture artifact mismatch")
  }
  const receiptPath = join(directory, "capture-receipt.json")
  let receipt
  try { receipt = JSON.parse((await boundedFile(receiptPath, 524288)).toString("utf8")) }
  catch (error) { if (error.code !== "ENOENT") throw error }
  if (receipt !== undefined) {
    if (receipt.requestDigest !== requestDigest) throw new Error("Capture replay mismatch")
    await verify(receipt.metadata)
    return receipt.metadata
  }
  // This durable exclusive intent prevents racing/repeated export and sealing.
  // An interrupted capture without a receipt retains uncertainty. Only a fully
  // verified, persisted receipt can recover a lost SSH response without re-export.
  await save(join(directory, "capture-request.json"), requestDigest)
  await sync(directory)
  await backend.exportWorkspace()
  await command(["/usr/bin/python3", "-I", join(tooling, "result.py"), "native-export", "capture.tar", source])
  const metadata = await command(["/usr/bin/python3", "-I", join(tooling, "result.py"), "native-seal", source], JSON.stringify({ completion, sensitiveValues: [...new Set([request.nonce, request.session, ...(invocation.container ? [invocation.container] : [])])] }))
  if (!JSON.parse(metadata).empty) {
    await sync(join(directory, "result/result.bundle"))
    await sync(join(directory, "result/result.json"))
    await sync(join(directory, "result"))
    await rename(join(directory, "result"), join(root, "result"))
    await sync(root)
    await sync(directory)
  }
  await verify(metadata)
  await save(join(directory, "capture-receipt.next"), JSON.stringify({ requestDigest, metadata }))
  await rename(join(directory, "capture-receipt.next"), receiptPath)
  await sync(directory)
  return metadata
}
