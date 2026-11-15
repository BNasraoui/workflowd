import { constants } from "node:fs"
import { open, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Schema } from "effect"
import { OBSERVATION_EVIDENCE } from "../errors"

/**
 * The event record of one CLI run: a fixed head file (`events.jsonl`) and,
 * once the head is full, numbered tail segments (`events.N.jsonl`) that the
 * worker rotates so the files on disk stay within the run's byte limit. An
 * index file names the segments that exist. Every file holds whole lines only.
 * A record without an index is a single file, as written before segments.
 */
type LinesFile = { readonly kind: "head" } | { readonly kind: "segment"; readonly n: number }
export type RecordFile = LinesFile | { readonly kind: "index" }

/** Bytes of one record file from an offset; empty at its end or when it is absent. */
export type RecordSource = (file: RecordFile, offset: number) => Promise<Uint8Array>

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

export type RecordIndex = { readonly first: number; readonly last: number }

const evidence = (message: string) =>
  Object.assign(new Error(message), { name: OBSERVATION_EVIDENCE })

const IndexRecord = Schema.Struct({
  version: Schema.Literal(1),
  first: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  last: Schema.Int,
})

/** The segments that exist: `first` is the oldest kept, `last` is the open one. */
export const decodeRecordIndex = (text: string): RecordIndex => {
  let index: typeof IndexRecord.Type
  try {
    index = Schema.decodeUnknownSync(IndexRecord)(JSON.parse(text))
  } catch {
    throw evidence("event record index fails to decode")
  }
  if (index.last < index.first) throw evidence("event record index fails to decode")
  return { first: index.first, last: index.last }
}

export const encodeRecordIndex = (index: RecordIndex) =>
  `${JSON.stringify({ version: 1, first: index.first, last: index.last })}\n`

const readIndex = async (source: RecordSource): Promise<RecordIndex | null> => {
  const bytes = await source({ kind: "index" }, 0)
  return bytes.length === 0 ? null : decodeRecordIndex(new TextDecoder().decode(bytes))
}

/**
 * Yields the complete lines of a record in the order the worker wrote them.
 * It reads the head, then each segment from the first one that still exists.
 * A segment that the worker removed before it was read is skipped whole, and
 * the partial line read from it is dropped, so no line is ever split. Without
 * an index the head is the whole record, as before segments existed.
 */
export const readEventRecord = <A>(options: {
  readonly source: RecordSource
  readonly pollIntervalMs: number
  /** Called after each drained poll; true ends the read after one final drain. */
  readonly shouldStop: () => Promise<boolean>
  readonly parse: (line: string) => A
  /** Yield an unterminated last line when the read ends. */
  readonly flushPartialAtEnd?: boolean
  /** Fail when one unterminated line grows past this many characters. */
  readonly maxPendingLength?: number
}): AsyncIterable<A> => ({
  async *[Symbol.asyncIterator]() {
    let current: LinesFile = { kind: "head" }
    let offset = 0
    let buffered = ""
    let decoder = new TextDecoder()
    const move = (next: LinesFile) => {
      current = next
      offset = 0
      buffered = ""
      decoder = new TextDecoder()
    }
    /** Yields the lines of the current file up to its present end. */
    async function* readAvailable() {
      for (;;) {
        const bytes = await options.source(current, offset)
        if (bytes.length === 0) return
        offset += bytes.length
        buffered += decoder.decode(bytes, { stream: true })
        for (;;) {
          const newline = buffered.indexOf("\n")
          if (newline < 0) break
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          yield options.parse(line)
        }
        if (options.maxPendingLength !== undefined && buffered.length > options.maxPendingLength)
          throw new Error("event record line exceeds the read limit")
      }
    }
    /** Drains every file that has bytes, moving past each sealed file. */
    async function* drain() {
      for (;;) {
        const entered = offset
        yield* readAvailable()
        const index = await readIndex(options.source)
        if (index === null) return
        // The index names a later file, so the worker sealed this one before
        // publishing it: read what was written before the index changed.
        const sealed = current.kind === "head" || current.n < index.last
        if (!sealed) return
        yield* readAvailable()
        const empty = entered === 0 && offset === 0
        move({
          kind: "segment",
          n: current.kind === "head" ? index.first : Math.max(current.n + 1, index.first),
        })
        // A file that never held a byte is not progress: wait a poll before the next.
        if (empty) return
      }
    }
    let stopped = false
    for (;;) {
      yield* drain()
      if (stopped) {
        if (options.flushPartialAtEnd === true && buffered !== "") yield options.parse(buffered)
        return
      }
      // Completion can publish its final bytes while shouldStop is awaiting
      // the manager. Drain once more after observing the terminal boundary.
      stopped = await options.shouldStop()
      if (!stopped) await Bun.sleep(options.pollIntervalMs)
    }
  },
})

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
  `${JSON.stringify({ type: "workflowd.line_dropped", bytes })}\n`

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
