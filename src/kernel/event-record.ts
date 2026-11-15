import { Schema } from "effect"
import { OBSERVATION_EVIDENCE } from "../errors"
import type { CliEvent } from "./cli-process-contract"

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

export type RecordIndex = { readonly first: number; readonly last: number }

const IndexRecord = Schema.Struct({
  version: Schema.Literal(1),
  first: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  last: Schema.Int,
})

/** Evidence, not a lost observation: the worker replaces the index whole. */
const undecodable = () =>
  Object.assign(new Error("event record index fails to decode"), { name: OBSERVATION_EVIDENCE })

/** The segments that exist: `first` is the oldest kept, `last` is the open one. */
export const decodeRecordIndex = (text: string): RecordIndex => {
  let index: typeof IndexRecord.Type
  try {
    index = Schema.decodeUnknownSync(IndexRecord)(JSON.parse(text))
  } catch {
    throw undecodable()
  }
  if (index.last < index.first) throw undecodable()
  return { first: index.first, last: index.last }
}

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

/** The type of the line the worker writes in place of a line over the line limit. */
export const LINE_DROPPED_TYPE = "workflowd.line_dropped"

const LINE_DROPPED_PREFIX = `{"type":"${LINE_DROPPED_TYPE}","bytes":`

/** Decodes one record line: the worker's line_dropped marker is a typed
 * event, and every other line is the CLI's own, decoded by `parse`. */
export const recordEventParser =
  (parse: (line: string) => CliEvent) =>
  (line: string): CliEvent => {
    if (line.startsWith(LINE_DROPPED_PREFIX)) {
      const bytes = Number(line.slice(LINE_DROPPED_PREFIX.length, -1))
      if (line.endsWith("}") && Number.isSafeInteger(bytes) && bytes >= 0)
        return { type: "record.line_dropped", bytes }
    }
    return parse(line)
  }
