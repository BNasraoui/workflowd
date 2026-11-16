import { Database, constants as sqlite } from "bun:sqlite"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { constants } from "node:fs"
import { access, open } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
/** Whether a file of SQLite beside `path` is present: a connection, or a journal it left. */
const companions = async (path: string) =>
  (await exists(`${path}-wal`)) ||
  (await exists(`${path}-shm`)) ||
  (await exists(`${path}-journal`))

/**
 * The byte range of SQLite's shared lock in a database file (`SHARED_FIRST`, `SHARED_SIZE` of the
 * unix VFS: 510 bytes from 2^30 + 2). A connection writes the file itself, and deletes its `-wal`
 * and `-shm` files at its close, only under a write lock of the whole range: its exclusive lock.
 */
const sharedFirst = 0x40000002
const sharedSize = 510
/** How long a read waits for a write lock of another process to end. */
const lockWaitMs = 2000
/** The text of a refusal: the file is locked for writing past the wait. */
const storeLocked = "another process holds it locked for writing"

/**
 * Runs `body` while this process holds a read lock of SQLite's shared range in the file at
 * `path`, as a reader of SQLite does. It is an open file description lock (F_OFD_SETLK), which
 * conflicts with SQLite's own locks in any process and stays until its own file is closed.
 */
async function sharedLock<A>(path: string, body: () => Promise<A>) {
  const file = await open(path, constants.O_RDONLY)
  const libc = dlopen("libc.so.6", {
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  })
  try {
    // struct flock: l_type F_RDLCK (0), l_whence SEEK_SET (0), l_start, l_len, l_pid 0.
    const lock = new DataView(new ArrayBuffer(32))
    lock.setBigInt64(8, BigInt(sharedFirst), true)
    lock.setBigInt64(16, BigInt(sharedSize), true)
    const until = Date.now() + lockWaitMs
    // F_OFD_SETLK (37) never blocks the process; the wait is a loop.
    while (libc.symbols.fcntl(file.fd, 37, ptr(lock.buffer)) !== 0) {
      if (Date.now() > until) throw new Error(storeLocked)
      await Bun.sleep(25)
    }
    return await body()
  } finally {
    libc.close()
    await file.close()
  }
}

const tableNames = (database: Database) => {
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

/**
 * The names of the tables of the SQLite file at `path`, or null when there is no file. workflowd
 * and the gateway each read the other's file with it, before they open their own store for
 * writing. It opens the file read only, writes neither the file nor its directory, and reads
 * under a read lock of SQLite's shared range, which holds off any process that would write the
 * file or delete the files of a connection beside it:
 *
 * - When a `-wal`, `-shm` or `-journal` file is present, a process has the file open, or left a
 *   journal; a read-only connection reads through them with SQLite's own locks, and makes no file.
 * - When none is present, every table is in the file itself. SQLite reads it as immutable, because
 *   a read-only connection to a file in WAL mode would make the `-wal` and `-shm` files and leave
 *   them. A connection that a process opens during that read makes its `-shm` file and cannot
 *   remove it under the lock: when one is present after the read, the immutable read is not used,
 *   and the file is read again through the connection's files.
 *
 * A write lock that another process holds past `lockWaitMs` is a refusal (`storeLocked`).
 */
export async function storeTables(path: string): Promise<ReadonlyArray<string> | null> {
  if (!(await exists(path))) return null
  const readOnly = () => tableNames(new Database(path, { readonly: true }))
  return await sharedLock(path, async () => {
    if (await companions(path)) return readOnly()
    const tables = tableNames(
      new Database(
        `${pathToFileURL(path).href}?immutable=1`,
        sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_URI,
      ),
    )
    return (await companions(path)) ? readOnly() : tables
  })
}
