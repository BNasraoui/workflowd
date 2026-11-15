import { constants } from "node:fs"
import { open, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  eventRecordPaths,
  LINE_DROPPED_TYPE,
  type RecordIndex,
  type RecordSource,
} from "./event-record"

/**
 * The files of an event record (see event-record.ts) and the worker's writer.
 */

const READ_CHUNK_BYTES = 64 * 1024

/** The record in a local directory. A file that does not exist reads as empty;
 * any other read error is a read to try again. */
export const localRecordSource = (eventsPath: string): RecordSource => {
  const paths = eventRecordPaths(eventsPath)
  return async (file, offset) => {
    try {
      const handle = await open(paths.of(file), "r")
      try {
        const bytes = Buffer.alloc(READ_CHUNK_BYTES)
        const read = await handle.read(bytes, 0, bytes.length, offset)
        return bytes.subarray(0, read.bytesRead)
      } finally {
        await handle.close()
      }
    } catch (error) {
      // The worker may not have created the file yet, or has rotated it away.
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return new Uint8Array()
      return null
    }
  }
}

export const encodeRecordIndex = (index: RecordIndex) =>
  `${JSON.stringify({ version: 1, first: index.first, last: index.last })}\n`

/** The bytes of all record files of one run, unless the launch gives its own. */
export const EVENT_RECORD_BYTES = 10 * 1024 * 1024

/** The line that replaces a line longer than the line limit. */
export const lineDroppedMarker = (bytes: number) =>
  `${JSON.stringify({ type: LINE_DROPPED_TYPE, bytes })}\n`

/** Two index files of the longest encoding, the index and its replacement. */
const INDEX_RESERVE_BYTES =
  2 *
  encodeRecordIndex({
    first: Number.MAX_SAFE_INTEGER,
    last: Number.MAX_SAFE_INTEGER,
  }).length

/** The head, a segment and a line are each a tenth of the total. */
const PARTS = 10

/** The smallest total whose segment holds the longest line_dropped marker;
 * the head and one segment then fit beside the two index files. */
export const MIN_EVENT_RECORD_BYTES = PARTS * lineDroppedMarker(Number.MAX_SAFE_INTEGER).length

/** Refuses a total under which the record cannot keep a head, one segment
 * and a marker. */
export const eventRecordBytes = (totalBytes: number) => {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < MIN_EVENT_RECORD_BYTES)
    throw new Error(
      `--max-output-bytes must be an integer of at least ${MIN_EVENT_RECORD_BYTES}, got ${totalBytes}`,
    )
  return totalBytes
}

/**
 * The limits of one record of `totalBytes`: the fixed head, one tail segment
 * and one line are each a tenth of it (1 MiB of the default 10 MiB). The
 * oldest segments are removed so that every file, the index and its
 * replacement included, stays within the total.
 */
export const eventRecordLimits = (totalBytes: number) => {
  const part = Math.floor(eventRecordBytes(totalBytes) / PARTS)
  return { total: totalBytes - INDEX_RESERVE_BYTES, head: part, segment: part, line: part }
}

const NEWLINE = 10

export type EventRecordWriter = {
  /** Appends bytes of the CLI's output; lines are stored once they end. */
  readonly write: (chunk: Uint8Array) => Promise<void>
  /** Stores the unterminated last line as it is and closes the open file; idempotent. */
  readonly close: () => Promise<void>
  /** Whether a tail segment was removed, so the record no longer holds every line. */
  readonly rotated: () => boolean
}

/**
 * Starts a fresh record at `eventsPath`. Lines go to the head until it is
 * full, then to tail segments. Every file holds whole lines, and the files
 * on disk never hold more than `totalBytes` together. The index is replaced
 * by a rename, so a reader never sees a partial index.
 */
export const openEventRecord = async (
  eventsPath: string,
  totalBytes: number,
): Promise<EventRecordWriter> => {
  const paths = eventRecordPaths(eventsPath)
  const limits = eventRecordLimits(totalBytes)
  const create = (path: string) =>
    open(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    )
  // A record left in this directory by an earlier launch is not this record.
  await rm(paths.index, { force: true })
  const directory = dirname(eventsPath)
  for (const name of await readdir(directory)) {
    const n = /\.([1-9][0-9]*)(?:\.jsonl)?$/.exec(name)?.[1]
    if (n !== undefined && join(directory, name) === paths.segment(Number(n)))
      await rm(join(directory, name), { force: true })
  }

  let file = await create(paths.head)
  let headBytes = 0
  let headSealed = false
  /** The kept segments, oldest first; the last one is open. */
  const segments: { readonly n: number; bytes: number }[] = []
  let rotated = false
  let batch: Uint8Array[] = []
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  /** The bytes of the line being dropped, or null. */
  let dropping: number | null = null
  let closed = false

  const flush = async () => {
    if (batch.length === 0) return
    const bytes = batch.length === 1 ? batch[0]! : Buffer.concat(batch)
    batch = []
    await file.write(bytes)
  }
  const publish = async (index: RecordIndex) => {
    const temporary = `${paths.index}.tmp-${process.pid}`
    await writeFile(temporary, encodeRecordIndex(index), {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    })
    await rename(temporary, paths.index)
  }
  /** Puts one whole line in the file where it fits, rotating if it must. */
  const place = async (line: Uint8Array) => {
    let changed = false
    if (!headSealed && headBytes + line.length <= limits.head) {
      batch.push(line)
      headBytes += line.length
      return
    }
    const open_ = segments.at(-1)
    if (open_ === undefined || open_.bytes + line.length > limits.segment) {
      // Seal the full file at a line boundary before the index names the next one.
      await flush()
      await file.close()
      headSealed = true
      const n = (open_?.n ?? 0) + 1
      file = await create(paths.segment(n))
      segments.push({ n, bytes: 0 })
      changed = true
    }
    let total = headBytes + segments.reduce((sum, segment) => sum + segment.bytes, 0)
    const removed: number[] = []
    while (total + line.length > limits.total && segments.length > 1) {
      const oldest = segments.shift()!
      removed.push(oldest.n)
      total -= oldest.bytes
    }
    if (changed || removed.length > 0)
      await publish({ first: segments[0]!.n, last: segments.at(-1)!.n })
    for (const n of removed) await rm(paths.segment(n), { force: true })
    if (removed.length > 0) rotated = true
    batch.push(line)
    segments.at(-1)!.bytes += line.length
  }
  const endLine = async () => {
    if (dropping !== null) {
      // The marker counts the dropped line's bytes without its newline.
      await place(new TextEncoder().encode(lineDroppedMarker(dropping - 1)))
      dropping = null
      return
    }
    const line = pending.length === 1 ? pending[0]! : Buffer.concat(pending)
    pending = []
    pendingBytes = 0
    await place(line)
  }
  const take = (part: Uint8Array) => {
    if (dropping !== null) dropping += part.length
    else if (pendingBytes + part.length > limits.line) {
      dropping = pendingBytes + part.length
      pending = []
      pendingBytes = 0
    } else {
      // A partial line outlives this chunk; keep a copy of its bytes.
      pending.push(Uint8Array.from(part))
      pendingBytes += part.length
    }
  }
  return {
    write: async (chunk) => {
      let start = 0
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, start)
        const end = newline < 0 ? chunk.length : newline + 1
        if (end > start) take(chunk.subarray(start, end))
        if (newline < 0) break
        await endLine()
        start = end
      }
      await flush()
    },
    close: async () => {
      if (closed) return
      closed = true
      if (dropping !== null) {
        await place(new TextEncoder().encode(lineDroppedMarker(dropping)))
        dropping = null
      } else if (pendingBytes > 0) await endLine()
      await flush()
      await file.close()
    },
    rotated: () => rotated,
  }
}
