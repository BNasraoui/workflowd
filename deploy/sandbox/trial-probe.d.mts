export const resultBound: number
export function probeLine(name: string, outcome: string, detail?: string): string
export function probeServiceBody(options: {
  readonly gateway: string
  readonly send?: (url: string, init: RequestInit & { duplex: "half" }) => Promise<Response>
  readonly size?: number
  /** How the probe reaches the gateway when `send` is not named; gateway-address.mjs's own. */
  readonly transport?: (gateway: string) => Promise<{
    readonly send: (url: string, init: RequestInit & { duplex: "half" }) => Promise<Response>
  }>
}): Promise<string>
export const blockedDestinations: ReadonlyArray<{
  readonly name: string
  readonly host: string
  readonly port: number
}>
export function networkLine(reached: ReadonlyArray<string>): string
/** The parts of native-docker.mjs that the box probe uses. */
export interface ProbeBoxModule {
  readonly boxNetwork: { readonly name: string; readonly subnet: string }
  readonly docker: (
    step: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<string>
  readonly makeBox: (binding: {
    readonly directory: string
    readonly image: string
    readonly name: string
  }) => {
    readonly start: () => Promise<void>
    readonly exec: (step: string, args: ReadonlyArray<string>) => Promise<string>
    readonly remove: () => Promise<void>
  }
}
export function probeBox(options: {
  readonly image: string
  readonly sudo?: string
  readonly box?: ProbeBoxModule
}): Promise<ReadonlyArray<string>>
