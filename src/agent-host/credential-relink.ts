import { constants } from "node:fs"
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import type { CredentialPolicy } from "./config"
import { credentialLock, credentialParent, inspectCredentialLayout } from "./credentials"
import { credentialRefusal } from "./protocol"

async function requireStopped(policy: CredentialPolicy) {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    const path = `/proc/${entry}`
    const info = await stat(path).catch(() => null)
    if (!info || ![policy.controllerUid, policy.agentUid].includes(info.uid)) continue
    const executable = await readlink(`${path}/exe`).catch(() => "")
    const arguments_ = await readFile(`${path}/cmdline`, "utf8").catch(() => "")
    if (
      policy.consumerExecutables.some(
        (binary) => binary === executable || arguments_.split("\0").includes(binary),
      )
    )
      throw credentialRefusal("codex", "credential_relink_in_progress")
  }
}

const Repair = Schema.Struct({
  client: Schema.Literals(["codex", "claude"]),
  source: Schema.Literals(["ben", "agent"]),
  sourceDevice: Schema.Int,
  sourceInode: Schema.Int,
  stagedDevice: Schema.optionalKey(Schema.Int),
  stagedInode: Schema.optionalKey(Schema.Int),
})

/** Administrative offline repair. Failure deliberately leaves a durable admission fence. */
export async function relinkCredentials(
  policy: CredentialPolicy,
  client: "codex" | "claude",
  source: "ben" | "agent",
) {
  const release = await credentialLock(policy, true)
  const handles: FileHandle[] = []
  const fail = (): never => {
    throw credentialRefusal(client, "shared_credential_diverged")
  }
  try {
    await requireStopped(policy)
    const login = policy[client]
    const sourcePath = source === "ben" ? login.benLink : login.agentLink
    const otherPath = source === "ben" ? login.agentLink : login.benLink
    const selected = await credentialParent(
      sourcePath,
      source === "ben" ? policy.controllerUid : policy.agentUid,
    )
    handles.push(selected.handle)
    const other = await credentialParent(
      otherPath,
      source === "ben" ? policy.agentUid : policy.controllerUid,
    )
    handles.push(other.handle)
    const canonical = await credentialParent(login.canonical, policy.ownerUid)
    handles.push(canonical.handle)
    const sourceInfo = await lstat(selected.path).catch(() => null)
    const otherInfo = await lstat(other.path).catch(() => null)
    if (
      otherInfo &&
      (!otherInfo.isSymbolicLink() || (await readlink(other.path)) !== login.canonical)
    )
      fail()
    const storePath = `/proc/self/fd/${canonical.handle.fd}`
    const journalPath = join(storePath, `${client}.repair.json`)
    const existing = await lstat(journalPath).catch(() => null)
    if (
      existing &&
      (!existing.isFile() || existing.uid !== policy.ownerUid || (existing.mode & 0o777) !== 0o600)
    )
      fail()
    const repair = existing
      ? Schema.decodeUnknownSync(Repair)(JSON.parse(await readFile(journalPath, "utf8")))
      : undefined
    if (repair && (repair.client !== client || repair.source !== source)) fail()
    if (!repair && sourceInfo?.isSymbolicLink()) {
      await inspectCredentialLayout(policy, client)
      return
    }
    const target = await lstat(canonical.path).catch(() => null)
    const installed =
      repair?.stagedInode !== undefined &&
      target?.ino === repair.stagedInode &&
      target?.dev === repair.stagedDevice
    if (!installed) {
      if (
        !sourceInfo?.isFile() ||
        sourceInfo.nlink !== 1 ||
        sourceInfo.uid !== (source === "ben" ? policy.controllerUid : policy.agentUid)
      )
        return fail()
      if (
        repair &&
        (repair.sourceDevice !== sourceInfo.dev || repair.sourceInode !== sourceInfo.ino)
      )
        fail()
      const persist = async (value: typeof Repair.Type) => {
        const temporary = `${journalPath}.next`
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await file.writeFile(JSON.stringify(value))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, journalPath)
        await canonical.handle.sync()
      }
      const intent = { client, source, sourceDevice: sourceInfo.dev, sourceInode: sourceInfo.ino }
      await persist(intent)
      const input = await open(selected.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      handles.push(input)
      const verified = await input.stat()
      if (
        verified.ino !== sourceInfo.ino ||
        verified.dev !== sourceInfo.dev ||
        verified.size > 1024 * 1024
      )
        fail()
      const stagingPath = join(storePath, `${client}.staging`)
      await unlink(stagingPath).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      })
      const staging = await open(
        stagingPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      handles.push(staging)
      await staging.writeFile(await input.readFile())
      await staging.chown(policy.ownerUid, policy.groupGid)
      await staging.chmod(0o660)
      await staging.sync()
      const staged = await staging.stat()
      await persist({ ...intent, stagedDevice: staged.dev, stagedInode: staged.ino })
      await rename(stagingPath, canonical.path)
      await canonical.handle.sync()
    } else if (
      sourceInfo &&
      !(sourceInfo.isSymbolicLink() && (await readlink(selected.path)) === login.canonical) &&
      !(
        sourceInfo.isFile() &&
        sourceInfo.dev === repair.sourceDevice &&
        sourceInfo.ino === repair.sourceInode
      )
    )
      fail()
    for (const parent of [selected, other]) {
      const temporary = `${parent.path}.workflowd-relink`
      await unlink(temporary).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      })
      await symlink(login.canonical, temporary)
      await rename(temporary, parent.path)
      await parent.handle.sync()
    }
    await inspectCredentialLayout(policy, client, true)
    await unlink(journalPath)
    await canonical.handle.sync()
  } catch (error) {
    if (typeof error === "object" && error !== null && "reason" in error) throw error
    throw credentialRefusal(client, "credential_relink_in_progress")
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
    await release()
  }
}
