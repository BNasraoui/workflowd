import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { storeTables } from "../../src/capability-control/store-tables"

/**
 * The read of another store's tables, before a process opens its own store: read only, no file
 * made or changed, and never a table list that a writer of the file could make wrong.
 */

async function withDirectory(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "wfd-store-tables-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
/** The sha256 of the file and the names of the files of its directory. */
const snapshot = async (root: string, path: string) => ({
  bytes: new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex"),
  names: (await readdir(root)).sort(),
})

test("a file in WAL mode that no process holds open: its tables, read with no file made or changed", async () => {
  await withDirectory(async (root) => {
    const path = join(root, "store.db")
    const writer = new Database(path)
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("CREATE TABLE kept (id INTEGER)")
    writer.close()
    const before = await snapshot(root, path)
    expect(before.names).toEqual(["store.db"])
    expect(await storeTables(path)).toEqual(["kept"])
    expect(await snapshot(root, path)).toEqual(before)
    expect(await storeTables(join(root, "absent.db"))).toBeNull()
  })
})

test("a file in WAL mode that a connection holds open: the tables of its WAL are read, and no file is changed", async () => {
  await withDirectory(async (root) => {
    const path = join(root, "store.db")
    const writer = new Database(path)
    try {
      writer.run("PRAGMA journal_mode = WAL")
      writer.run("PRAGMA wal_autocheckpoint = 0")
      writer.run("CREATE TABLE first (id INTEGER)")
      // The second table is only in the WAL: the file itself holds an older schema.
      writer.run("CREATE TABLE second (id INTEGER)")
      const before = await snapshot(root, path)
      expect(before.names).toEqual(["store.db", "store.db-shm", "store.db-wal"])
      expect(await storeTables(path)).toEqual(["first", "second"])
      expect(await snapshot(root, path)).toEqual(before)
    } finally {
      writer.close()
    }
  })
})

test("a file that a connection holds locked for writing is refused after the wait, and read once the lock ends", async () => {
  await withDirectory(async (root) => {
    const path = join(root, "store.db")
    const writer = new Database(path)
    try {
      writer.run("PRAGMA journal_mode = DELETE")
      writer.run("CREATE TABLE first (id INTEGER)")
      // An exclusive lock of SQLite, as a writer holds it while it writes the file itself.
      writer.run("BEGIN EXCLUSIVE")
      const started = performance.now()
      await expect(storeTables(path)).rejects.toThrow("another process holds it locked for writing")
      expect(
        performance.now() - started,
        "the refusal comes after the wait of 2 seconds",
      ).toBeGreaterThanOrEqual(2000)
      writer.run("COMMIT")
      expect(await storeTables(path)).toEqual(["first"])
      expect((await readdir(root)).sort()).toEqual(["store.db"])
    } finally {
      writer.close()
    }
  })
})
