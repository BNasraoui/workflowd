import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { dlopen, FFIType } from "bun:ffi"

const LOCK_SH = 1
const LOCK_EX = 2
const LOCK_NB = 4

/**
 * Takes flock(2) on a private lock file without waiting. The kernel releases the lock when the
 * returned release closes the file or when the holder ends, SIGKILL included; the file stays.
 * Resolves to undefined when another open file holds a conflicting lock. A lock file that is not a
 * regular file of ownerUid with one link and mode 0600 is refused, since others could hold it.
 */
export async function tryFileLock(path: string, ownerUid: number, exclusive: boolean) {
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.uid !== ownerUid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error(`${path} is not a private lock file`)
    const libc = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    // With LOCK_NB on an open descriptor, flock fails only when another lock conflicts.
    const taken = libc.symbols.flock(handle.fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) === 0
    libc.close()
    if (taken) return () => handle.close()
  } catch (error) {
    await handle.close()
    throw error
  }
  await handle.close()
  return undefined
}
