import { readFile } from "node:fs/promises"
import { decodeRecordIndex, eventRecordPaths } from "../../src/kernel/event-record.ts"

const absentAsEmpty = (path) =>
  readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return ""
    throw error
  })

/**
 * The whole event record of a run as text: the head, then each segment that
 * the index names, in sequence. A segment the worker removed between the
 * index read and its own read is missing from the text.
 */
export const readEventRecordText = async (eventsPath) => {
  const paths = eventRecordPaths(eventsPath)
  let text = await readFile(paths.head, "utf8")
  const index = await absentAsEmpty(paths.index)
  if (index === "") return text
  const { first, last } = decodeRecordIndex(index)
  for (let n = first; n <= last; n++) text += await absentAsEmpty(paths.segment(n))
  return text
}
