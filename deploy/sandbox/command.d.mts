import type { Readable } from "node:stream"

export const environment: { readonly PATH: string; readonly HOME: string }
export function command(
  step: string,
  binary: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string
    readonly stdin?: Readable
    readonly timeoutMs?: number
    readonly cwd?: string
  },
): Promise<string>
export function readArchive(
  step: string,
  binary: string,
  args: ReadonlyArray<string>,
  options?: { readonly timeoutMs?: number },
): { readonly stream: Readable; readonly done: Promise<void> }
