import { checkOpenCodeMigration } from "./opencode-credentials"
import { constants } from "node:fs"
import { lstat, open, readlink, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import type { CredentialPolicy } from "./config"
import { credentialRefusal, type CredentialClient } from "./protocol"

/** Walk with directory descriptors: a writable home cannot redirect privileged path operations. */
export async function credentialParent(path: string, ownerUid: number) {
  if (resolve(path) !== path) throw new Error("invalid credential path")
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    for (const part of dirname(path).split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      await handle.close()
      handle = next
      const info = await handle.stat()
      if (
        (info.uid !== 0 && info.uid !== ownerUid) ||
        ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
      )
        throw new Error("unsafe credential ancestry")
    }
    return { handle, path: `/proc/self/fd/${handle.fd}/${basename(path)}` }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function credentialLock(policy: CredentialPolicy, exclusive: boolean) {
  const directory = await credentialParent(join(policy.root, "admission.lock"), policy.ownerUid)
  let handle: FileHandle | undefined
  const libc = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  try {
    handle = await open(
      directory.path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.uid !== policy.ownerUid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      libc.symbols.flock(handle.fd, (exclusive ? 2 : 1) | 4) !== 0
    )
      throw new Error("admission locked")
    const owned = handle
    return async () => {
      await owned.close()
      libc.close()
      await directory.handle.close()
    }
  } catch {
    await handle?.close()
    libc.close()
    await directory.handle.close()
    throw credentialRefusal("codex", "credential_relink_in_progress")
  }
}

export async function inspectCredentialLayout(
  policy: CredentialPolicy,
  client: "codex" | "claude",
  allowRepair = false,
) {
  const login = policy[client]
  const fail = (reason: Parameters<typeof credentialRefusal>[1]): never => {
    throw credentialRefusal(client, reason)
  }
  const parents: FileHandle[] = []
  try {
    const store = await credentialParent(login.canonical, policy.ownerUid)
    parents.push(store.handle)
    const directory = await store.handle.stat()
    if (
      ![policy.root, join(policy.root, client)].includes(dirname(login.canonical)) ||
      directory.uid !== policy.ownerUid ||
      directory.gid !== policy.groupGid ||
      (directory.mode & 0o777) !== 0o710
    )
      fail("shared_credential_permissions_invalid")
    const repair = await lstat(`/proc/self/fd/${store.handle.fd}/${client}.repair.json`).catch(
      () => null,
    )
    if (repair && !allowRepair) fail("credential_relink_in_progress")
    const target = await lstat(store.path).catch(() => null)
    if (!target) return fail("shared_credential_link_broken")
    if (!target.isFile() || target.nlink !== 1) fail("shared_credential_diverged")
    if (
      target.uid !== policy.ownerUid ||
      target.gid !== policy.groupGid ||
      (target.mode & 0o777) !== 0o660
    )
      fail("shared_credential_permissions_invalid")
    for (const [path, uid] of [
      [login.benLink, policy.controllerUid],
      [login.agentLink, policy.agentUid],
    ] as const) {
      const parent = await credentialParent(path, uid)
      parents.push(parent.handle)
      const link = await lstat(parent.path).catch(() => null)
      if (!link) return fail("shared_credential_link_broken")
      if (!link.isSymbolicLink() || (await readlink(parent.path)) !== login.canonical)
        fail("shared_credential_diverged")
      const linked = await stat(parent.path).catch(() => null)
      if (!linked) return fail("shared_credential_link_broken")
      if (linked.dev !== target.dev || linked.ino !== target.ino) fail("shared_credential_diverged")
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "reason" in error) throw error
    fail("shared_credential_permissions_invalid")
  } finally {
    await Promise.all(parents.map((handle) => handle.close()))
  }
}

export async function checkCredentialAdmission(policy: CredentialPolicy, client: CredentialClient) {
  const release = await credentialLock(policy, false)
  try {
    if (client === "opencode") {
      if (!policy.opencode) throw credentialRefusal(client, "opencode_grant_migration_incomplete")
      await checkOpenCodeMigration(policy.opencode)
    } else await inspectCredentialLayout(policy, client)
  } finally {
    await release()
  }
}
