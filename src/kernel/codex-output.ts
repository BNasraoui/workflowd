import { open } from "node:fs/promises"

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
      if (await options.shouldStop()) return
      await Bun.sleep(options.pollIntervalMs)
    }
  },
})
