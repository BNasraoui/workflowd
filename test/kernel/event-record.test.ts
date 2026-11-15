import { expect, test } from "bun:test"
import { readdir, readFile, stat, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { observationUnavailable } from "../../src/kernel/cli-process-contract"
import {
  decodeRecordIndex,
  encodeRecordIndex,
  eventRecordLimits,
  eventRecordPaths,
  EVENT_RECORD_LIMITS,
  lineDroppedMarker,
  localRecordSource,
  openEventRecord,
  readEventRecord,
  type EventRecordWriter,
  type RecordSource,
} from "../../src/kernel/event-record"
import { parseClaudeDispatchEvent } from "../../src/kernel/claude-dispatch"

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
        if (reads === 1) return (await local(file, offset)).subarray(0, 10)
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

/** The record files in a directory with their sizes. */
const recordFiles = async (root: string) => {
  const files = new Map<string, number>()
  for (const name of await readdir(root))
    if (name.startsWith("events")) files.set(name, (await stat(join(root, name))).size)
  return files
}

test("the limits are 1 MiB each for a record of 10 MiB and a quarter for a small one", () => {
  expect(eventRecordLimits(EVENT_RECORD_LIMITS.totalBytes)).toMatchObject({
    head: 1024 * 1024,
    segment: 1024 * 1024,
    line: 1024 * 1024,
  })
  const small = eventRecordLimits(LIMIT)
  expect(small.head).toBeLessThanOrEqual(LIMIT / 4)
  expect(small.line).toBe(small.segment)
  expect(eventRecordLimits(Number.NaN)).toMatchObject({ head: 0, segment: 0, line: 0 })
})

test("a writer that gets three times its limit keeps the head and the newest lines within the limit", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, LIMIT)
    const count = (3 * LIMIT) / 2048
    await writeChunked(writer, Array.from({ length: count }, (_, seq) => numbered(seq)).join(""))
    expect(writer.rotated()).toBe(true)
    await writer.close()
    const files = await recordFiles(root)
    expect([...files.values()].reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(LIMIT)
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
    expect([...(await recordFiles(root)).keys()].sort()).toEqual(["events", "events.notes"])
    expect(await readAll(localRecordSource(head))).toEqual(["new"])
  }))

test("a record without room for a line keeps nothing", async () =>
  withRoot(async (root) => {
    const head = join(root, "events.jsonl")
    const writer = await openEventRecord(head, 0)
    await writer.write(new TextEncoder().encode("a\nb\n"))
    await writer.close()
    expect([...(await recordFiles(root)).values()]).toEqual([0])
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

test(
  "a reader beside a live writer gets whole lines in order, never twice, and only whole indexes",
  async () =>
    withRoot(async (root) => {
      const head = join(root, "events.jsonl")
      const lines = 4000
      const script = join(root, "writer.ts")
      const module = new URL("../../src/kernel/event-record.ts", import.meta.url).pathname
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
