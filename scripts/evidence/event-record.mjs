import { readEventRecord } from "../../src/kernel/event-record.ts"
import { localRecordSource } from "../../src/kernel/event-record-files.ts"

/**
 * The whole event record of a run as text, one line per record line, read by
 * the product's reader: the head, then each segment that still exists. An
 * unterminated last line is included.
 */
export const readEventRecordText = async (eventsPath) => {
  const lines = []
  for await (const line of readEventRecord({
    source: localRecordSource(eventsPath),
    pollIntervalMs: 0,
    shouldStop: async () => true,
    parse: (line) => line,
    flushPartialAtEnd: true,
  }))
    lines.push(line)
  return lines.join("\n")
}
