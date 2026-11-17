import type { Readable } from "node:stream"

export function sealRun(options: {
  readonly directory: string
  readonly native: string
  readonly sourceSha: string
  readonly identity: { readonly name: string; readonly email: string }
  readonly reply: string
  /** One read of the stopped workspace as a tar archive; `done` fails when the read fails. */
  readonly workspace: () => { readonly stream: Readable; readonly done: Promise<void> }
}): Promise<void>
