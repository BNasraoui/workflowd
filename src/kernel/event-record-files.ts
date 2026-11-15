import { constants } from "node:fs"
import { open, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { LINE_DROPPED_TYPE, type RecordIndex, type RecordSource } from "./event-record"

/**
 * The files of an event record (see event-record.ts) and the worker's writer.
 */

/** The file names of a record whose head is `eventsPath`. */
export const eventRecordPaths = (eventsPath: string) => {
  const extension = eventsPath.endsWith(".jsonl") ? ".jsonl" : ""
  const stem = eventsPath.slice(0, eventsPath.length - extension.length)
  return {
    head: eventsPath,
    index: `${stem}.index.json`,
    segment: (n: number) => `${stem}.${n}${extension}`,
  }
}

const READ_CHUNK_BYTES = 64 * 1024

/** The record in a local directory. A missing or unreadable file reads as empty. */
export const localRecordSource = (eventsPath: string): RecordSource => {
  const paths = eventRecordPaths(eventsPath)
  return async (file, offset) => {
    const path =
      file.kind === "head"
        ? paths.head
        : file.kind === "index"
          ? paths.index
          : paths.segment(file.n)
    try {
      const handle = await open(path, "r")
      try {
        const bytes = Buffer.alloc(READ_CHUNK_BYTES)
        const read = await handle.read(bytes, 0, bytes.length, offset)
        return bytes.subarray(0, read.bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      // The worker may not have created the file yet, or has rotated it away.
      return new Uint8Array()
    }
  }
}

export const encodeRecordIndex = (index: RecordIndex) =>
  `${JSON.stringify({ version: 1, first: index.first, last: index.last })}\n`

/** The size limits of an event record. Each applies to every run. */
export const EVENT_RECORD_LIMITS = {
  /** The bytes of all record files of one run, unless the launch gives its own. */
  totalBytes: 10 * 1024 * 1024,
  /** The fixed first file: the start of the run, never removed. */
  headBytes: 1024 * 1024,
  /** One tail segment. The oldest segments are removed to keep the total. */
  segmentBytes: 1024 * 1024,
  /** One line. A longer line is replaced by a line_dropped marker. */
  lineBytes: 1024 * 1024,
} as const

/** Two index files of the longest encoding, the index and its replacement. */
const INDEX_RESERVE_BYTES =
  2 *
  encodeRecordIndex({
    first: Number.MAX_SAFE_INTEGER,
    last: Number.MAX_SAFE_INTEGER,
  }).length

/** The limits for one record of `totalBytes`. A total under four times the
 * head keeps a quarter each for the head and a segment, so at least two
 * segments always fit beside the head. */
export const eventRecordLimits = (totalBytes: number) => {
  // The index and its replacement are on disk too.
  const total = Number.isSafeInteger(totalBytes) ? Math.max(0, totalBytes - INDEX_RESERVE_BYTES) : 0
  const quarter = Math.floor(total / 4)
  const segment = Math.min(EVENT_RECORD_LIMITS.segmentBytes, quarter)
  return {
    total,
    head: Math.min(EVENT_RECORD_LIMITS.headBytes, quarter),
    segment,
    line: Math.min(EVENT_RECORD_LIMITS.lineBytes, segment),
  }
}

/** The line that replaces a line longer than the line limit. */
export const lineDroppedMarker = (bytes: number) =>
  `${JSON.stringify({ type: LINE_DROPPED_TYPE, bytes })}\n`

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
  const head = basename(eventsPath)
  const extension = head.endsWith(".jsonl") ? ".jsonl" : ""
  const stem = head.slice(0, head.length - extension.length)
  for (const name of await readdir(directory))
    if (
      name.startsWith(`${stem}.`) &&
      name.endsWith(extension) &&
      /^[0-9]+$/.test(name.slice(stem.length + 1, name.length - extension.length))
    )
      await rm(join(directory, name), { force: true })

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
    if (line.length > limits.segment) return
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
