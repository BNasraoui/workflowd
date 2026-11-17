import type { Readable } from "node:stream"

export function directoryArchive(path: string): {
  readonly stream: Readable
  readonly done: Promise<void>
}
