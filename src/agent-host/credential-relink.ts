import { constants, type Stats } from "node:fs"
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Schema } from "effect"
import type { CredentialPolicy } from "./config"
import { credentialLock, credentialParent, inspectCredentialLayout } from "./credentials"
import { credentialRefusal, credentialReason } from "./protocol"

async function resolvedConsumers(paths: readonly string[]) {
  const installed = new Set<string>()
  const roots = new Set<string>()
  const add = async (path: string) => {
    const resolved = await realpath(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (resolved) installed.add(resolved)
    return resolved
  }
  for (const path of paths) {
    const binary = await add(path)
    if (!binary) continue
    // Claude's native installer retains previous versions; running clients may use any of them.
    if (basename(dirname(binary)) === "versions") {
      roots.add(dirname(binary))
      for (const name of await readdir(dirname(binary))) await add(join(dirname(binary), name))
    }
    // Codex's npm launcher delegates to a platform package, or its bundled vendor tree.
    if (basename(binary) === "codex.js") {
      const packageRoot = dirname(dirname(binary))
      const scope = dirname(packageRoot)
      const packages = [
        packageRoot,
        ...(await readdir(scope))
          .filter((name) => name.startsWith("codex-"))
          .map((name) => join(scope, name)),
      ]
      for (const root of packages) {
        const vendor = join(root, "vendor")
        roots.add(vendor)
        const targets = await readdir(vendor).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
          throw error
        })
        for (const target of targets) {
          await add(join(vendor, target, "codex", "codex"))
          await add(join(vendor, target, "bin", "codex"))
        }
      }
    }
  }
  return { installed, roots }
}

async function requireStopped(policy: CredentialPolicy, client: "codex" | "claude") {
  const { installed, roots } = await resolvedConsumers(policy.consumerExecutables)
  const fail = (): never => {
    throw credentialRefusal(client, "credential_relink_in_progress")
  }
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    const path = `/proc/${entry}`
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (info.uid === policy.agentUid) fail()
    if (info.uid !== policy.controllerUid) continue
    try {
      const target = await readlink(`${path}/exe`)
      if (target.endsWith(" (deleted)")) {
        const original = target.slice(0, -" (deleted)".length)
        if (installed.has(original) || [...roots].some((root) => original.startsWith(`${root}/`)))
          fail()
      }
      const executable = await realpath(`${path}/exe`)
      if (installed.has(executable)) fail()
      // Script entrypoints run inside Node; resolve argv paths too, never argv display names.
      const arguments_ = (await readFile(`${path}/cmdline`, "utf8")).split("\0")
      for (const argument of arguments_.filter((value) => value.startsWith("/"))) {
        const resolved = await realpath(argument).catch(() => undefined)
        if (resolved && installed.has(resolved)) fail()
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      fail()
    }
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

async function importReplacement(
  policy: CredentialPolicy,
  client: "codex" | "claude",
  source: "ben" | "agent",
  selected: Awaited<ReturnType<typeof credentialParent>>,
  canonical: Awaited<ReturnType<typeof credentialParent>>,
  repair: typeof Repair.Type | undefined,
) {
  const handles: FileHandle[] = []
  const fail = (): never => {
    throw credentialRefusal(client, "shared_credential_diverged")
  }
  const sourceInfo = await lstat(selected.path).catch(() => null)
  const storePath = `/proc/self/fd/${canonical.handle.fd}`
  const journalPath = join(storePath, `${client}.repair.json`)
  try {
    if (
      !sourceInfo?.isFile() ||
      sourceInfo.nlink !== 1 ||
      sourceInfo.uid !== (source === "ben" ? policy.controllerUid : policy.agentUid)
    )
      return fail()
    if (repair && (repair.sourceDevice !== sourceInfo.dev || repair.sourceInode !== sourceInfo.ino))
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
    const input = await open(
      selected.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    handles.push(input)
    const verified = await input.stat()
    if (
      !verified.isFile() ||
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
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
  }
}

async function validateRepairedSource(path: string, canonical: string, repair: typeof Repair.Type) {
  const info = await lstat(path).catch(() => null)
  if (!info) return
  if (info.isSymbolicLink() && (await readlink(path)) === canonical) return
  if (info.isFile() && info.dev === repair.sourceDevice && info.ino === repair.sourceInode) return
  throw credentialRefusal(repair.client, "shared_credential_diverged")
}

function validAutomaticStore(
  policy: CredentialPolicy,
  client: "codex" | "claude",
  directory: Stats,
  canonical: Stats,
) {
  return (
    [policy.root, join(policy.root, client)].includes(dirname(policy[client].canonical)) &&
    directory.uid === policy.ownerUid &&
    directory.gid === policy.groupGid &&
    (directory.mode & 0o777) === 0o710 &&
    canonical.isFile() &&
    canonical.nlink === 1 &&
    canonical.uid === policy.ownerUid &&
    canonical.gid === policy.groupGid &&
    (canonical.mode & 0o777) === 0o660
  )
}

function newerPrivateLogin(info: Stats, canonical: Stats, uid: number) {
  return (
    info.isFile() &&
    info.nlink === 1 &&
    info.uid === uid &&
    (info.mode & 0o777) === 0o600 &&
    info.size > 0 &&
    info.size <= 1024 * 1024 &&
    info.mtimeMs > canonical.mtimeMs
  )
}

const absentOrStat = (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })

/** Select only a private newer replacement beside an unchanged canonical link.
 * Runs under the same exclusive lock as the journaled repair; never resumes a journal automatically.
 */
async function automaticSource(policy: CredentialPolicy, client: "codex" | "claude") {
  const login = policy[client]
  const handles: FileHandle[] = []
  const fail = (): never => {
    throw credentialRefusal(client, "shared_credential_diverged")
  }
  try {
    const store = await credentialParent(login.canonical, policy.ownerUid)
    handles.push(store.handle)
    const directory = await store.handle.stat()
    const canonical = await lstat(store.path)
    if (!validAutomaticStore(policy, client, directory, canonical)) fail()
    for (const name of [
      `${client}.repair.json`,
      `${client}.repair.json.next`,
      `${client}.staging`,
    ]) {
      if (await absentOrStat(join(`/proc/self/fd/${store.handle.fd}`, name))) fail()
    }
    let selected: typeof Repair.Type | undefined
    for (const [source, path, uid] of [
      ["ben", login.benLink, policy.controllerUid],
      ["agent", login.agentLink, policy.agentUid],
    ] as const) {
      const parent = await credentialParent(path, uid)
      handles.push(parent.handle)
      if (await absentOrStat(`${parent.path}.workflowd-relink`)) fail()
      const info = await lstat(parent.path)
      if (info.isSymbolicLink()) {
        if ((await readlink(parent.path)) !== login.canonical) fail()
      } else {
        if (selected || !newerPrivateLogin(info, canonical, uid)) fail()
        selected = { client, source, sourceDevice: info.dev, sourceInode: info.ino }
      }
    }
    return selected ?? fail()
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
  }
}

/** Admission stays locked through handoff, including after an automatic repair. */
export async function admitHostCredentials(policy: CredentialPolicy, client: "codex" | "claude") {
  let release = await credentialLock(policy, false)
  try {
    try {
      await inspectCredentialLayout(policy, client)
    } catch (error) {
      if (credentialReason(error) !== "shared_credential_diverged") throw error
      await release()
      release = async () => {}
      await relinkCredentials(policy, client, "auto")
      release = await credentialLock(policy, false)
      await inspectCredentialLayout(policy, client)
    }
    return release
  } catch (error) {
    await release()
    throw error
  }
}

async function loadRepair(
  path: string,
  ownerUid: number,
  client: "codex" | "claude",
  source: "ben" | "agent",
  automatic: boolean,
) {
  const existing = await absentOrStat(path)
  if (!existing) return undefined
  const fail = (): never => {
    throw credentialRefusal(client, "shared_credential_diverged")
  }
  if (
    automatic ||
    !existing.isFile() ||
    existing.uid !== ownerUid ||
    (existing.mode & 0o777) !== 0o600
  )
    fail()
  const repair = Schema.decodeUnknownSync(Repair)(JSON.parse(await readFile(path, "utf8")))
  if (repair.client !== client || repair.source !== source) fail()
  return repair
}

/** Administrative offline repair. Failure deliberately leaves a durable admission fence. */
export async function relinkCredentials(
  policy: CredentialPolicy,
  client: "codex" | "claude",
  requestedSource: "ben" | "agent" | "auto",
) {
  const release = await credentialLock(policy, true)
  const handles: FileHandle[] = []
  const fail = (): never => {
    throw credentialRefusal(client, "shared_credential_diverged")
  }
  try {
    const automatic = requestedSource === "auto" ? await automaticSource(policy, client) : undefined
    const source = automatic?.source ?? (requestedSource === "agent" ? "agent" : "ben")
    await requireStopped(policy, client)
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
    const repair = await loadRepair(
      journalPath,
      policy.ownerUid,
      client,
      source,
      automatic !== undefined,
    )
    if (automatic && !otherInfo) fail()
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
      await requireStopped(policy, client)
      await importReplacement(policy, client, source, selected, canonical, repair ?? automatic)
    } else {
      await validateRepairedSource(selected.path, login.canonical, repair)
    }
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
