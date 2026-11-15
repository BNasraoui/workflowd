import { expect, test } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { observationUnavailable } from "../../src/kernel/cli-process-contract"
import {
  decodeRecordIndex,
  encodeRecordIndex,
  eventRecordPaths,
  localRecordSource,
  readEventRecord,
  type RecordSource,
} from "../../src/kernel/event-record"

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
