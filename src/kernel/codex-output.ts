import { readdir, rm, stat } from "node:fs/promises"
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
