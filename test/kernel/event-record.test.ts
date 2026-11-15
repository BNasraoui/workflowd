import { expect, test } from "bun:test"
import { mkdir, readFile, stat, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { observationUnavailable } from "../../src/kernel/cli-process-contract"
import { HostExchangeFile } from "../../src/agent-host/protocol"
import {
  decodeRecordIndex,
  eventRecordPaths,
  readEventRecord,
  recordEventParser,
  type RecordSource,
} from "../../src/kernel/event-record"
import {
  encodeRecordIndex,
  eventRecordLimits,
  EVENT_RECORD_BYTES,
  MIN_EVENT_RECORD_BYTES,
  lineDroppedMarker,
  localRecordSource,
  openEventRecord,
  type EventRecordWriter,
} from "../../src/kernel/event-record-files"
import { parseClaudeDispatchEvent } from "../../src/kernel/claude-dispatch"
import { recordFiles } from "./event-record-harness"

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "event-record-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const readAll = async (
  source: RecordSource,
  options: { readonly stops?: number; readonly flushPartialAtEnd?: boolean } = {},
) => {
  let polls = 0
  const lines: string[] = []
  for await (const line of readEventRecord({
    source,
    pollIntervalMs: 1,
    shouldStop: async () => ++polls >= (options.stops ?? 1),
    parse: (text) => text,
    ...(options.flushPartialAtEnd === undefined
      ? {}
      : { flushPartialAtEnd: options.flushPartialAtEnd }),
  }))
    lines.push(line)
  return lines
}

test("record file names follow the head file", () => {
  const local = eventRecordPaths("/run/events.jsonl")
  expect(local.index).toBe("/run/events.index.json")
  expect(local.segment(3)).toBe("/run/events.3.jsonl")
  const host = eventRecordPaths("/io/events")
  expect(host.index).toBe("/io/events.index.json")
  expect(host.segment(12)).toBe("/io/events.12")
})

test("the agent host exchange accepts each record file name of a host launch, and no other", () => {
  const names = eventRecordPaths("events")
  const accepts = (name: string) => Schema.is(HostExchangeFile)(name)
  for (const file of [
    { kind: "head" },
    { kind: "index" },
    { kind: "segment", n: 1 },
    { kind: "segment", n: 999_999_999 },
  ] as const)
    expect(accepts(names.of(file))).toBe(true)
  expect(accepts(names.of({ kind: "segment", n: 1_000_000_000 }))).toBe(false)
  expect(accepts(eventRecordPaths("events.jsonl").segment(1))).toBe(false)
  expect(accepts("events.0")).toBe(false)
  expect(accepts("../events")).toBe(false)
})

test("a record without an index is its head file only, as before segments", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    // A stray segment without an index is never read.
    await writeFile(head, "a\nb\npartial")
    await writeFile(eventRecordPaths(head).segment(1), "stray\n")
    expect(await readAll(localRecordSource(head))).toEqual(["a", "b"])
    expect(await readAll(localRecordSource(head), { flushPartialAtEnd: true })).toEqual([
      "a",
      "b",
      "partial",
    ])
  }))

test("a missing head reads as an empty record", async () =>
  withRoot(async (root) => {
    expect(await readAll(localRecordSource(join(root, "events.jsonl")))).toEqual([])
  }))

/** A record file that cannot be read (a directory in its place) until its
 * `readable`-th read, when the worker's file replaces it. */
const unreadableUntil = (head: string, path: string, content: string, readable: number) => {
  const local = localRecordSource(head)
  const paths = eventRecordPaths(head)
  let reads = 0
  const source: RecordSource = async (file, offset) => {
    if (paths.of(file) === path && ++reads === readable) {
      await rm(path, { recursive: true })
      await writeFile(path, content)
    }
    return local(file, offset)
  }
  return source
}

test("a sealed segment that cannot be read is read again on the next poll, and its lines are not skipped", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const paths = eventRecordPaths(head)
    await writeFile(head, "h1\n")
    await mkdir(paths.segment(1))
    await writeFile(paths.segment(2), "s2\n")
    await writeFile(paths.index, encodeRecordIndex({ first: 1, last: 2 }))
    // It cannot be read on the first pass nor on the pass after the stop.
    const source = unreadableUntil(head, paths.segment(1), "s1\n", 3)
    expect(await readAll(source)).toEqual(["h1", "s1", "s2"])
  }))

test("an index that cannot be read is read again, not taken as a record without segments", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const paths = eventRecordPaths(head)
    await writeFile(head, "h1\n")
    await mkdir(paths.index)
    await writeFile(paths.segment(1), "s1\n")
    const source = unreadableUntil(head, paths.index, encodeRecordIndex({ first: 1, last: 1 }), 3)
    expect(await readAll(source)).toEqual(["h1", "s1"])
  }))

test("the reader reads the head, then each kept segment in order", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const paths = eventRecordPaths(head)
    await writeFile(head, "h1\nh2\n")
    await writeFile(paths.segment(1), "s1a\ns1b\n")
    await writeFile(paths.segment(2), "s2a\n")
    await writeFile(paths.segment(3), "s3a\ns3")
    await writeFile(paths.index, encodeRecordIndex({ first: 1, last: 3 }))
    expect(await readAll(localRecordSource(head))).toEqual(["h1", "h2", "s1a", "s1b", "s2a", "s3a"])
  }))

test("segments removed before the reader reached them are skipped whole", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const paths = eventRecordPaths(head)
    await writeFile(head, "h1\n")
    await writeFile(paths.segment(4), "s4\n")
    await writeFile(paths.segment(5), "s5\n")
    await writeFile(paths.index, encodeRecordIndex({ first: 4, last: 5 }))
    expect(await readAll(localRecordSource(head))).toEqual(["h1", "s4", "s5"])
  }))

test("a segment removed while it is read drops its partial line, never splits it", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const paths = eventRecordPaths(head)
    await writeFile(head, "h1\n")
    await writeFile(paths.segment(1), `s1a\n${"x".repeat(100)}\n`)
    await writeFile(paths.segment(2), "s2a\n")
    await writeFile(paths.index, encodeRecordIndex({ first: 1, last: 2 }))
    const local = localRecordSource(head)
    let reads = 0
    // The first segment's file goes away after its first 10 bytes were read.
    const source: RecordSource = async (file, offset) => {
      if (file.kind === "segment" && file.n === 1) {
        reads += 1
        if (reads === 1) return (await local(file, offset))!.subarray(0, 10)
        await unlink(paths.segment(1)).catch(() => {})
        await writeFile(paths.index, encodeRecordIndex({ first: 2, last: 2 }))
      }
      return local(file, offset)
    }
    expect(await readAll(source)).toEqual(["h1", "s1a", "s2a"])
  }))

test("the open segment is read again until the worker seals it", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const paths = eventRecordPaths(head)
    await writeFile(head, "h1\n")
    await writeFile(paths.segment(1), "s1a\n")
    await writeFile(paths.index, encodeRecordIndex({ first: 1, last: 1 }))
    let polls = 0
    const lines: string[] = []
    for await (const line of readEventRecord({
      source: localRecordSource(head),
      pollIntervalMs: 1,
      shouldStop: async () => {
        polls += 1
        if (polls === 1) {
          await writeFile(paths.segment(1), "s1a\ns1b\n")
          await writeFile(paths.segment(2), "s2a\n")
          await writeFile(paths.index, encodeRecordIndex({ first: 1, last: 2 }))
        }
        return polls >= 2
      },
      parse: (text) => text,
    }))
      lines.push(line)
    expect(lines).toEqual(["h1", "s1a", "s1b", "s2a"])
  }))

test("an index that names segments with no bytes costs one poll per segment", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    await writeFile(head, "h1\n")
    await writeFile(eventRecordPaths(head).index, encodeRecordIndex({ first: 1, last: 1000 }))
    // Ten polls move through ten empty segments, not through the whole forged range.
    const requested = new Set<number>()
    const local = localRecordSource(head)
    const source: RecordSource = (file, offset) => {
      if (file.kind === "segment") requested.add(file.n)
      return local(file, offset)
    }
    expect(await readAll(source, { stops: 10 })).toEqual(["h1"])
    expect(requested.size).toBeLessThanOrEqual(12)
  }))

test("an index that fails to decode is evidence, not a lost observation", async () => {
  for (const text of [
    "{",
    "{}",
    '{"version":1,"first":0,"last":1}',
    '{"version":1,"first":3,"last":2}',
  ]) {
    let failure: unknown
    try {
      decodeRecordIndex(text)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(observationUnavailable(failure)).toBe(false)
  }
  expect(decodeRecordIndex(encodeRecordIndex({ first: 2, last: 4 }))).toEqual({ first: 2, last: 4 })
})

test("one unterminated line past the read limit fails the read", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    await writeFile(head, `ok\n${"x".repeat(64)}`)
    const read = async () => {
      const lines: string[] = []
      for await (const line of readEventRecord({
        source: localRecordSource(head),
        pollIntervalMs: 1,
        shouldStop: async () => true,
        parse: (text) => text,
        maxPendingLength: 32,
      }))
        lines.push(line)
      return lines
    }
    await expect(read()).rejects.toThrow("event record line exceeds the read limit")
  }))

const LIMIT = 64 * 1024

const Numbered = Schema.Struct({ seq: Schema.Number, pad: Schema.String })
const seqOf = (line: string) => Schema.decodeUnknownSync(Numbered)(JSON.parse(line)).seq

/** One numbered line of exactly `bytes` bytes with its newline. */
const numbered = (seq: number, bytes = 2048) => {
  const prefix = `{"seq":${seq},"pad":"`
  return `${prefix}${"x".repeat(bytes - prefix.length - 3)}"}\n`
}

/** Writes the text in chunks of `size` bytes, so lines cross chunk ends. */
const writeChunked = async (writer: EventRecordWriter, text: string, size = 1000) => {
  const bytes = new TextEncoder().encode(text)
  for (let start = 0; start < bytes.length; start += size)
    await writer.write(bytes.subarray(start, start + size))
}

test("the head, a segment and a line are a tenth of the total each: 1 MiB of the default 10 MiB", () => {
  expect(eventRecordLimits(EVENT_RECORD_BYTES)).toEqual({
    // Two index files of the longest encoding, 63 bytes each, are within the total.
    total: EVENT_RECORD_BYTES - 126,
    head: 1024 * 1024,
    segment: 1024 * 1024,
    line: 1024 * 1024,
  })
  expect(eventRecordLimits(LIMIT)).toMatchObject({ head: 6553, segment: 6553, line: 6553 })
  // The smallest total still holds the longest marker in a segment beside the head.
  const smallest = eventRecordLimits(MIN_EVENT_RECORD_BYTES)
  expect(smallest.segment).toBe(lineDroppedMarker(Number.MAX_SAFE_INTEGER).length)
  expect(smallest.head + smallest.segment).toBeLessThanOrEqual(smallest.total)
})

test("a writer that gets three times its limit keeps the head and the newest lines within the limit", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    const count = (3 * LIMIT) / 2048
    await writeChunked(writer, Array.from({ length: count }, (_, seq) => numbered(seq)).join(""))
    expect(writer.rotated()).toBe(true)
    await writer.close()
    const { files, bytes } = await recordFiles(root)
    expect(bytes).toBeLessThanOrEqual(LIMIT)
    const index = decodeRecordIndex(await readFile(eventRecordPaths(head).index, "utf8"))
    expect(index.first).toBeGreaterThan(1)
    // Exactly the segments the index names exist.
    const segments = [...files.keys()].filter((name) => /^events\.[0-9]+\.jsonl$/.test(name))
    expect(segments.sort()).toEqual(
      Array.from(
        { length: index.last - index.first + 1 },
        (_, n) => `events.${index.first + n}.jsonl`,
      ).sort(),
    )
    // Every file holds whole lines; the head starts the run and the last segment ends it.
    const lines = (text: string) => {
      expect(text.endsWith("\n")).toBe(true)
      return text.slice(0, -1).split("\n").map(seqOf)
    }
    const kept = lines(await readFile(head, "utf8"))
    expect(kept[0]).toBe(0)
    const tail: number[] = []
    for (let n = index.first; n <= index.last; n++)
      tail.push(...lines(await readFile(eventRecordPaths(head).segment(n), "utf8")))
    expect(tail.at(-1)).toBe(count - 1)
    expect(tail).toEqual(Array.from({ length: tail.length }, (_, i) => tail[0]! + i))
    // The reader gives the head, then the kept tail.
    const read = (await readAll(localRecordSource(head))).map(seqOf)
    expect(read).toEqual([...kept, ...tail])
  }))

test("a line over the line limit is replaced by a marker with its size", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    const line = eventRecordLimits(LIMIT).line
    await writeChunked(writer, `${numbered(1, 100)}${"y".repeat(2 * line)}\n${numbered(2, 100)}`)
    expect(writer.rotated()).toBe(false)
    await writer.close()
    expect(await readFile(head, "utf8")).toBe(
      `${numbered(1, 100)}${lineDroppedMarker(2 * line)}${numbered(2, 100)}`,
    )
  }))

test("the last line without a newline is stored as it is, or as a marker when too long", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    await writer.write(new TextEncoder().encode("a\npartial"))
    await writer.close()
    await writer.close()
    expect(await readFile(head, "utf8")).toBe("a\npartial")
    const long = await openEventRecord(head, LIMIT)
    await long.write(new TextEncoder().encode("z".repeat(eventRecordLimits(LIMIT).line + 1)))
    await long.close()
    expect(await readFile(head, "utf8")).toBe(lineDroppedMarker(eventRecordLimits(LIMIT).line + 1))
  }))

test("a new record removes the index and the segments of an earlier one", async () =>
  withRoot(async (root) => {
    const head = join(root, "events")
    const paths = eventRecordPaths(head)
    await writeFile(paths.index, encodeRecordIndex({ first: 1, last: 2 }))
    await writeFile(paths.segment(1), "old\n")
    await writeFile(paths.segment(2), "old\n")
    await writeFile(join(root, "events.notes"), "kept\n")
    const writer = await openEventRecord(head, LIMIT)
    await writer.write(new TextEncoder().encode("new\n"))
    await writer.close()
    expect([...(await recordFiles(root)).files.keys()].sort()).toEqual(["events", "events.notes"])
    expect(await readAll(localRecordSource(head))).toEqual(["new"])
  }))

test("a record total without room for a head, a segment and a marker is refused before any file is touched", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    await writeFile(head, "earlier\n")
    for (const total of [0, MIN_EVENT_RECORD_BYTES - 1, Number.NaN])
      await expect(openEventRecord(head, total)).rejects.toThrow(
        `--max-output-bytes must be an integer of at least ${MIN_EVENT_RECORD_BYTES}, got ${total}`,
      )
    expect(await readFile(head, "utf8")).toBe("earlier\n")
  }))

/** Claude assistant lines numbered from 0, padded to `bytes` each. */
const message = (seq: number, bytes = 2048, text = `m${seq}`) => {
  const line = (pad: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, pad })
  return `${line("x".repeat(bytes - 1 - line("").length))}\n`
}

test("a late reader whose segments are removed between two index reads goes on at the first that exists", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    let seq = 0
    const more = (lines: number) =>
      writeChunked(writer, Array.from({ length: lines }, () => message(seq++)).join(""))
    // The controller restarts after the record already rotated.
    await more(96)
    const local = localRecordSource(head)
    let segmentReads = 0
    let removedBetween = false
    const source: RecordSource = async (file, offset) => {
      // The reader has read the index and goes to its first segment; before it
      // reads that segment, the worker writes on and removes it and the next ones.
      if (file.kind === "segment" && ++segmentReads === 1) {
        const before = decodeRecordIndex(await readFile(eventRecordPaths(head).index, "utf8"))
        await more(48)
        const after = decodeRecordIndex(await readFile(eventRecordPaths(head).index, "utf8"))
        removedBetween = after.first > file.n && before.first === file.n
      }
      return local(file, offset)
    }
    let stops = 0
    const texts: string[] = []
    for await (const event of readEventRecord({
      source,
      pollIntervalMs: 1,
      shouldStop: async () => {
        stops += 1
        if (stops === 1) {
          await writeChunked(writer, message(-1, 2048, "final answer"))
          await writer.close()
        }
        return stops >= 2
      },
      parse: parseClaudeDispatchEvent,
    })) {
      expect(event.type).toBe("agent_message")
      if (event.type === "agent_message") texts.push(event.text)
    }
    expect(removedBetween).toBe(true)
    expect(texts.at(-1)).toBe("final answer")
    const seqs = texts.slice(0, -1).map((text) => Number(text.slice(1)))
    // The head, a gap where segments were removed, then whole lines in order.
    expect(seqs[0]).toBe(0)
    expect(seqs.at(-1)).toBe(seq - 1)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
    expect(new Set(seqs).size).toBe(seqs.length)
  }))

/**
 * A reader that is far behind the writer when the worker ends: the segment it
 * stands on, at its start, is removed before its last read. `behind` puts the
 * reader there; the worker then writes past its whole tail, writes the final
 * message and ends.
 */
const readBehindToTheEnd = async (behind: "open segment" | "lapped") =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    let seq = 0
    const more = (lines: number) =>
      writeChunked(writer, Array.from({ length: lines }, () => message(seq++)).join(""))
    await more(behind === "open segment" ? 10 : 96)
    const local = localRecordSource(head)
    let segmentReads = 0
    const standing: number[] = []
    const source: RecordSource = async (file, offset) => {
      if (file.kind === "segment" && ++segmentReads === 1) {
        standing.push(file.n)
        // The reader comes between the creation of the open segment and its first line.
        if (behind === "open segment") return new Uint8Array()
        // The worker removes the first kept segment before the reader reads it.
        await more(48)
      }
      return local(file, offset)
    }
    let stops = 0
    const texts: string[] = []
    for await (const event of readEventRecord({
      source,
      pollIntervalMs: 1,
      shouldStop: async () => {
        stops += 1
        await more((3 * LIMIT) / 2048)
        await writeChunked(writer, message(-1, 2048, "final answer"))
        await writer.close()
        return true
      },
      parse: parseClaudeDispatchEvent,
    })) {
      if (event.type === "agent_message") texts.push(event.text)
    }
    expect(stops).toBe(1)
    expect(standing).toHaveLength(1)
    expect(texts.at(-1)).toBe("final answer")
    const seqs = texts.slice(0, -1).map((text) => Number(text.slice(1)))
    expect(seqs[0]).toBe(0)
    expect(seqs.at(-1)).toBe(seq - 1)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
  })

test("a reader at the start of the open segment when the worker writes past its tail and ends gives the final message", async () =>
  readBehindToTheEnd("open segment"))

test("a reader lapped by the writer when the worker ends gives the final message", async () =>
  readBehindToTheEnd("lapped"))

test(
  "a reader beside a live writer gets whole lines in order, never twice, and only whole indexes",
  async () =>
    withRoot(async (root) => {
      const head = join(root, "events.jsonl")
      const lines = 4000
      const script = join(root, "writer.ts")
      const module = new URL("../../src/kernel/event-record-files.ts", import.meta.url).pathname
      await writeFile(
        script,
        `import { openEventRecord } from ${JSON.stringify(module)}
const writer = await openEventRecord(${JSON.stringify(head)}, ${LIMIT})
for (let seq = 0; seq < ${lines}; seq++) {
  const line = JSON.stringify({ seq, pad: "x".repeat(seq % 700) }) + "\\n"
  const bytes = new TextEncoder().encode(line)
  // Two writes per line: the reader may see half a line at the end of a file.
  await writer.write(bytes.subarray(0, 7))
  await writer.write(bytes.subarray(7))
  if (seq % 50 === 0) await Bun.sleep(1)
}
await writer.close()
`,
      )
      await writeFile(head, "")
      const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" })
      let done = false
      const exited = child.exited.then((code) => {
        done = true
        return code
      })
      // Sample the index while the writer replaces it: every read is a whole
      // index, and each replacement is a new file, which a rename gives and an
      // overwrite in place does not.
      const indexPath = eventRecordPaths(head).index
      const inodes = new Set<number>()
      let samples = 0
      const sampler = (async () => {
        while (!done) {
          try {
            const info = await stat(indexPath)
            const text = await readFile(indexPath, "utf8")
            decodeRecordIndex(text)
            inodes.add(info.ino)
            samples += 1
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          }
        }
      })()
      const seqs: number[] = []
      for await (const line of readEventRecord({
        source: localRecordSource(head),
        pollIntervalMs: 1,
        shouldStop: async () => done,
        parse: (text) => text,
      })) {
        const value = Schema.decodeUnknownSync(Numbered)(JSON.parse(line))
        expect(value.pad).toBe("x".repeat(value.seq % 700))
        seqs.push(value.seq)
      }
      await sampler
      expect(await exited).toBe(0)
      expect(seqs[0]).toBe(0)
      expect(seqs.at(-1)).toBe(lines - 1)
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
      expect(samples).toBeGreaterThan(0)
      expect(inodes.size).toBeGreaterThan(1)
    }),
  30_000,
)

/** The lines of the record at `head` as the controller reads them. */
const readRecord = (head: string, flushPartialAtEnd = false) =>
  readAll(localRecordSource(head), { flushPartialAtEnd })

test("lines that end exactly at the head limit and the segment limit fill those files, and the next line opens a new one", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const { segment } = eventRecordLimits(LIMIT)
    // Three lines that fill a file of `segment` bytes exactly, for the head and segment 1.
    const third = Math.floor(segment / 3)
    const sizes = [third, third, segment - 2 * third]
    const lines = [...sizes, ...sizes, 2048].map((bytes, seq) => numbered(seq, bytes))
    const writer = await openEventRecord(head, LIMIT)
    await writeChunked(writer, lines.join(""))
    await writer.close()
    expect(Object.fromEntries((await recordFiles(root)).files)).toMatchObject({
      "events.jsonl": segment,
      "events.1.jsonl": segment,
      "events.2.jsonl": 2048,
    })
    expect((await readRecord(head)).map(seqOf)).toEqual([0, 1, 2, 3, 4, 5, 6])
  }))

test("a CLI that writes one byte at a time is stored and read as whole lines", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    // Eight lines of 2 KiB cross from the head into a segment.
    await writeChunked(writer, Array.from({ length: 8 }, (_, seq) => numbered(seq)).join(""), 1)
    await writer.close()
    expect((await recordFiles(root)).files.has("events.1.jsonl")).toBe(true)
    expect((await readRecord(head)).map(seqOf)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  }))

test("a line exactly at the line limit is kept, and a line one byte over is a marker of its size", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const { line } = eventRecordLimits(LIMIT)
    const writer = await openEventRecord(head, LIMIT)
    // The limit counts the newline; the marker counts the line without it.
    await writeChunked(writer, numbered(0, line) + numbered(1, line + 1) + numbered(2))
    await writer.close()
    const read = await readRecord(head)
    expect(read).toHaveLength(3)
    expect(seqOf(read[0]!)).toBe(0)
    expect(read[0]).toHaveLength(line - 1)
    expect(recordEventParser(parseClaudeDispatchEvent)(read[1]!)).toEqual({
      type: "record.line_dropped",
      bytes: line,
    })
    expect(seqOf(read[2]!)).toBe(2)
  }))

test("a CLI whose output ends with no newline: its last line is stored, the host reader yields it and the controller reader does not, as before segments", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    const lines = Array.from({ length: 4 }, (_, seq) => numbered(seq)).join("")
    await writeChunked(writer, `${lines}${numbered(4).slice(0, -1)}`)
    await writer.close()
    // The last line went to a segment, unterminated.
    expect((await readFile(eventRecordPaths(head).segment(1), "utf8")).endsWith("}")).toBe(true)
    expect((await readRecord(head, true)).map(seqOf)).toEqual([0, 1, 2, 3, 4])
    expect((await readRecord(head)).map(seqOf)).toEqual([0, 1, 2, 3])
  }))

test("a reader that starts after many segments were removed reads the head, then the kept segments in order", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    const count = (20 * LIMIT) / 2048
    await writeChunked(writer, Array.from({ length: count }, (_, seq) => numbered(seq)).join(""))
    await writer.close()
    const index = decodeRecordIndex(await readFile(eventRecordPaths(head).index, "utf8"))
    expect(index.first).toBeGreaterThan(100)
    const seqs = (await readRecord(head)).map(seqOf)
    const headLines = Math.floor(eventRecordLimits(LIMIT).head / 2048)
    expect(seqs.slice(0, headLines)).toEqual(Array.from({ length: headLines }, (_, seq) => seq))
    // After the head, the kept tail ends with the last line, with no gap and no repeat.
    const tail = seqs.slice(headLines)
    expect(tail.at(-1)).toBe(count - 1)
    expect(tail).toEqual(Array.from({ length: tail.length }, (_, i) => tail[0]! + i))
    expect(tail[0]).toBeGreaterThan(headLines)
  }))

test("the line_dropped marker is a typed event and every other line is the CLI's", () => {
  const parse = recordEventParser(parseClaudeDispatchEvent)
  expect(parse(lineDroppedMarker(2_000_000).trimEnd())).toEqual({
    type: "record.line_dropped",
    bytes: 2_000_000,
  })
  expect(parse('{"type":"workflowd.line_dropped","bytes":"x"}')).toEqual({ type: "other" })
  expect(parse("not json")).toEqual({ type: "other" })
  expect(parse(message(1, 200).trimEnd())).toEqual({ type: "agent_message", text: "m1" })
})
