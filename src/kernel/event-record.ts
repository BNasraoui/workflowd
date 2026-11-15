import { open } from "node:fs/promises"
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
