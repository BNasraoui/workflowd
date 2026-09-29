import { open, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"

export const cleanupFinishedCustody = async (options: {
  readonly root: string
  readonly protectedRunIds: ReadonlyArray<string>
  readonly retentionMs: number
  readonly now: Date
}) => {
  const protectedRuns = new Set(options.protectedRunIds)
  const entries = await readdir(options.root, { withFileTypes: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return []
      throw cause
    },
  )
  let removed = 0
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^agent-run-[a-zA-Z0-9_-]+$/.test(entry.name) ||
      protectedRuns.has(entry.name)
    ) {
      continue
    }
    const directory = join(options.root, entry.name)
    const terminalTimes = await Promise.all(
      ["result.json", "cancelled.json"].map((name) =>
        stat(join(directory, name)).then(
          (info) => info.mtimeMs,
          () => null,
        ),
      ),
    )
    const newest = Math.max(...terminalTimes.filter((value) => value !== null))
    if (Number.isFinite(newest) && options.now.getTime() - newest >= options.retentionMs) {
      await rm(directory, { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

/** Reads an append-only JSONL file from a byte offset and retains an
 * unterminated tail between polls. The parser never sees a partial line. */
export const incrementalLines = <A>(options: {
  readonly path: string
  readonly pollIntervalMs: number
  readonly shouldStop: () => Promise<boolean>
  readonly parse: (line: string) => A
}): AsyncIterable<A> => ({
  async *[Symbol.asyncIterator]() {
    let offset = 0
    let buffered = ""
    let stopped = false
    const decoder = new TextDecoder()
    for (;;) {
      try {
        const file = await open(options.path, "r")
        try {
          const info = await file.stat()
          while (offset < info.size) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - offset))
            const read = await file.read(chunk, 0, chunk.length, offset)
            if (read.bytesRead === 0) break
            offset += read.bytesRead
            buffered += decoder.decode(chunk.subarray(0, read.bytesRead), { stream: true })
          }
        } finally {
          await file.close()
        }
      } catch {
        // The service may not have opened stdout yet.
      }
      for (;;) {
        const newline = buffered.indexOf("\n")
        if (newline < 0) break
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        yield options.parse(line)
      }
      if (stopped) return
      // Completion can publish its final bytes while shouldStop is awaiting
      // the manager. Drain once more after observing the terminal boundary.
      stopped = await options.shouldStop()
      if (!stopped) await Bun.sleep(options.pollIntervalMs)
    }
  },
})
