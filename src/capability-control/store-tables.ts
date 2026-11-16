import { Database, constants } from "bun:sqlite"
import { access } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/**
 * The names of the tables of the SQLite file at `path`, or null when there is no file. workflowd
 * and the gateway each read the other's file with it, before they open their own store for
 * writing. It opens the file read only, and writes neither the file nor its directory:
 *
 * - When the file's `-wal` or `-shm` file is present, a process has the file open, or left it
 *   so; a read-only connection reads through them and makes no file.
 * - When neither is present, every table is in the file itself. SQLite reads it as immutable,
 *   because a read-only connection to a file in WAL mode would make both files and leave them.
 */
export async function storeTables(path: string): Promise<ReadonlyArray<string> | null> {
  if (!(await exists(path))) return null
  const open = (await exists(`${path}-wal`)) || (await exists(`${path}-shm`))
  const database = open
    ? new Database(path, { readonly: true })
    : new Database(
        `${pathToFileURL(path).href}?immutable=1`,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
      )
  try {
    return database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map(({ name }) => name)
  } finally {
    database.close()
  }
}
