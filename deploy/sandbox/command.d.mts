export const environment: { readonly PATH: string; readonly HOME: string }
export function command(
  step: string,
  binary: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly input?: string
    readonly stdin?: NodeJS.ReadableStream
    readonly timeoutMs?: number
    readonly cwd?: string
  },
): Promise<string>
