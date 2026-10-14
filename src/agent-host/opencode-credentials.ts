import { constants as fileConstants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { credentialParent } from "./credentials"
import { createHash } from "node:crypto"
import { lstat, open, readFile, readdir, readlink, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Database, constants } from "bun:sqlite"
import { Schema } from "effect"
import { credentialRefusal } from "./protocol"

export const OpenCodeMigrationPolicy = Schema.Struct({
  source: Schema.String,
  database: Schema.String,
  journal: Schema.String,
  agentUid: Schema.Int,
  agentGid: Schema.Int,
  sourceUnits: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.@-]+\.service$/)),
      scope: Schema.Literals(["user", "system"]),
      user: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z_][a-z0-9_-]*$/))),
    }),
  ),
})
export type OpenCodeMigrationPolicy = typeof OpenCodeMigrationPolicy.Type
const Journal = Schema.Struct({
  phase: Schema.Literals(["prepared", "moved"]),
  ids: Schema.Array(Schema.String),
})
const Ids = Schema.Array(Schema.Struct({ id: Schema.String }))
const Columns = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))
const columns = [
  "id",
  "integration_id",
  "label",
  "value",
  "connector_id",
  "method_id",
  "active",
  "time_created",
  "time_updated",
]
const migrationDigest = "e7ac064a3e797bace36c6cc906108f7ab7f03d702aaab1a023d1f5cd7f9925e4"
const refused = () => credentialRefusal("opencode", "opencode_grant_migration_incomplete")

function validateSchema(db: Database, name: "main" | "destination") {
  const ids = Schema.decodeUnknownSync(Ids)(
    db.query(`SELECT id FROM ${name}.migration ORDER BY id`).all(),
  ).map((row) => row.id)
  const fields = Schema.decodeUnknownSync(Columns)(
    db.query(`PRAGMA ${name}.table_info(credential)`).all(),
  )
  if (
    createHash("sha256").update(JSON.stringify(ids)).digest("hex") !== migrationDigest ||
    JSON.stringify(fields.map((row) => row.name)) !== JSON.stringify(columns) ||
    fields.some((row, index) => row.type.toLowerCase() !== (index < 6 ? "text" : "integer"))
  )
    throw refused()
}

async function requireClosed(paths: readonly string[], agentUid: number) {
  const owners = await Promise.all(paths.map(async (path) => (await lstat(path)).uid))
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    const processInfo = await stat(`/proc/${pid}`).catch(() => null)
    if (!processInfo) continue
    if (processInfo.uid === agentUid) throw refused()
    if (!owners.includes(processInfo.uid)) continue
    const descriptors = await readdir(`/proc/${pid}/fd`).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw refused()
    })
    for (const fd of descriptors) {
      const path = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")
      if (paths.some((database) => path === database || path === `${database}-wal`)) throw refused()
    }
  }
}

async function saveJournal(path: string, value: typeof Journal.Type) {
  const file = await open(`${path}.next`, "w", 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(`${path}.next`, path)
  const directory = await open(dirname(path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function pinAttachedDestination(path: string, pinned: FileHandle) {
  const expected = await pinned.stat()
  const attached: FileHandle[] = []
  try {
    for (const descriptor of await readdir("/proc/self/fd")) {
      if (Number(descriptor) === pinned.fd) continue
      const entry = `/proc/self/fd/${descriptor}`
      if ((await readlink(entry).catch(() => undefined)) !== path) continue
      const file = await open(entry, fileConstants.O_RDONLY | fileConstants.O_NONBLOCK)
      attached.push(file)
      const actual = await file.stat()
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
        throw refused()
    }
    if (!attached.length) throw refused()
    return attached
  } catch (error) {
    await Promise.all(attached.map((file) => file.close()))
    throw error
  }
}

/** Drained, schema-pinned migration. SQLite's rollback super-journal commits both databases together. */
export async function migrateOpenCodeGrants(policy: OpenCodeMigrationPolicy) {
  let db: Database | undefined
  const handles: FileHandle[] = []
  let stage = "consumers"
  try {
    await requireClosed([policy.source, policy.database], policy.agentUid)
    stage = "paths"
    for (const path of [policy.source, policy.database]) {
      const info = await lstat(path)
      if (!info.isFile() || info.nlink !== 1) throw refused()
      // A legacy credential file could silently recreate a second active store.
      if (
        await lstat(join(dirname(path), "auth.json")).then(
          () => true,
          () => false,
        )
      )
        throw refused()
    }
    stage = "destination-record"
    const recorded = await lstat(policy.database)
    stage = "destination-parent"
    const parent = await credentialParent(policy.database, policy.agentUid)
    handles.push(parent.handle)
    stage = "destination-open"
    const destination = await open(
      parent.path,
      fileConstants.O_RDWR | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    )
    handles.push(destination)
    const verifyDestination = async () => {
      const info = await destination.stat()
      const named = await lstat(parent.path)
      const absolute = await lstat(policy.database)
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== policy.agentUid ||
        info.gid !== policy.agentGid ||
        (info.mode & 0o777) !== 0o600 ||
        [recorded, named, absolute].some(
          (other) => !other.isFile() || other.dev !== info.dev || other.ino !== info.ino,
        )
      )
        throw refused()
    }
    stage = "destination-verify"
    await verifyDestination()
    stage = "open"
    db = new Database(
      policy.source,
      constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
    )
    db.run("PRAGMA trusted_schema=OFF")
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    db.run("PRAGMA journal_mode=DELETE")
    // SQLite NOFOLLOW rejects /proc/self/fd aliases. Verify the descriptor it
    // actually opened before any destination pragmas or credential writes.
    await verifyDestination()
    db.run("ATTACH DATABASE ? AS destination", [policy.database])
    handles.push(...(await pinAttachedDestination(policy.database, destination)))
    await verifyDestination()
    db.run("PRAGMA destination.wal_checkpoint(TRUNCATE)")
    db.run("PRAGMA destination.journal_mode=DELETE")
    db.run("PRAGMA main.synchronous=FULL")
    db.run("PRAGMA destination.synchronous=FULL")
    stage = "schema"
    validateSchema(db, "main")
    validateSchema(db, "destination")
    stage = "journal"
    const sourceIds = Schema.decodeUnknownSync(Ids)(
      db.query("SELECT id FROM main.credential ORDER BY id").all(),
    ).map((row) => row.id)
    const destinationIds = Schema.decodeUnknownSync(Ids)(
      db.query("SELECT id FROM destination.credential ORDER BY id").all(),
    ).map((row) => row.id)
    const existing = await readFile(policy.journal, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw refused()
    })
    const journal =
      existing === undefined ? undefined : Schema.decodeUnknownSync(Journal)(JSON.parse(existing))
    const ids = journal?.ids ?? sourceIds
    if (ids.length === 0) throw refused()
    const alreadyMoved =
      sourceIds.length === 0 && JSON.stringify(destinationIds) === JSON.stringify(ids)
    if (!alreadyMoved) {
      if (
        destinationIds.length !== 0 ||
        JSON.stringify(sourceIds) !== JSON.stringify(ids) ||
        journal?.phase === "moved"
      )
        throw refused()
      await requireClosed([policy.source, policy.database], policy.agentUid)
      await saveJournal(policy.journal, { phase: "prepared", ids })
      stage = "transfer"
      db.transaction(() => {
        db!.run(
          `INSERT INTO destination.credential (${columns.join(",")}) SELECT ${columns.join(",")} FROM main.credential`,
        )
        db!.run("DELETE FROM main.credential")
      }).exclusive()
    }
    stage = "finish"
    db.close()
    db = undefined
    await verifyDestination()
    await destination.sync()
    await saveJournal(policy.journal, { phase: "moved", ids })
  } catch {
    throw Object.assign(refused(), { detail: `opencode_grant_migration_incomplete:${stage}` })
  } finally {
    db?.close()
    await Promise.all(handles.map((handle) => handle.close()))
  }
}

export async function checkOpenCodeMigration(policy: OpenCodeMigrationPolicy) {
  let source: Database | undefined
  let destination: Database | undefined
  try {
    const journal = Schema.decodeUnknownSync(Journal)(
      JSON.parse(await readFile(policy.journal, "utf8")),
    )
    const info = await lstat(policy.database)
    if (
      journal.phase !== "moved" ||
      !info.isFile() ||
      info.uid !== policy.agentUid ||
      (info.mode & 0o777) !== 0o600
    )
      throw refused()
    source = new Database(
      policy.source,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
    )
    destination = new Database(
      policy.database,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
    )
    for (const db of [source, destination]) {
      db.run("PRAGMA trusted_schema=OFF")
      db.run("PRAGMA query_only=ON")
    }
    if (
      source.query("SELECT id FROM credential LIMIT 1").get() !== null ||
      destination.query("SELECT id FROM credential LIMIT 1").get() === null
    )
      throw refused()
    if (
      await lstat(join(dirname(policy.source), "auth.json")).then(
        () => true,
        () => false,
      )
    )
      throw refused()
  } catch {
    throw refused()
  } finally {
    source?.close()
    destination?.close()
  }
}
