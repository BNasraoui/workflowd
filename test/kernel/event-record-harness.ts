import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/** The event record files in a directory, with their sizes and their total. */
export const recordFiles = async (directory: string) => {
  const files = new Map<string, number>()
  for (const name of await readdir(directory))
    if (name.startsWith("events")) files.set(name, (await stat(join(directory, name))).size)
  return { files, bytes: [...files.values()].reduce((sum, size) => sum + size, 0) }
}
