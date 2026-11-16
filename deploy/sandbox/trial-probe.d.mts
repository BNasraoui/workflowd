export const resultBound: number
export function probeLine(name: string, outcome: string, detail?: string): string
export function probeServiceBody(options: {
  readonly gateway: string
  readonly send?: (url: string, init: RequestInit & { duplex: "half" }) => Promise<Response>
  readonly size?: number
}): Promise<string>
export const blockedDestinations: ReadonlyArray<{
  readonly name: string
  readonly host: string
  readonly port: number
}>
export function networkLine(reached: ReadonlyArray<string>): string
export function probeBox(options: {
  readonly image: string
  readonly run?: (
    step: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<string>
  readonly sudo?: string
}): Promise<ReadonlyArray<string>>
