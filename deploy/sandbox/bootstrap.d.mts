/** The harness of a job's run: the box of `native-runner.mjs`. */
export const boxHarness: ReadonlyArray<string>
export function prepare(options: {
  readonly harness: ReadonlyArray<string>
  readonly directory?: string
  readonly environment?: Record<string, string | undefined>
  readonly identity?: (input: string | URL, init?: RequestInit) => Promise<Response>
  readonly backoff?: (attempt: number) => number
  readonly sessionKey?: { readonly publicKey: string; readonly privateKey: string }
  readonly transport?: (gateway: string) => Promise<{
    readonly send: (url: URL, init: RequestInit) => Promise<Response>
    readonly address: string | undefined
  }>
}): Promise<void>
