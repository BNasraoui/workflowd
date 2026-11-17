import type { Agent } from "node:https"
import type { LookupFunction } from "node:net"

export const localApiSocket: string
export function dnsAnswerAddress(bytes: Buffer): string | undefined
export function localDnsQuery(
  name: string,
  run?: (
    file: string,
    args: ReadonlyArray<string>,
    options: object,
    callback: (error: Error | null, stdout: string) => void,
  ) => unknown,
): Promise<Buffer>
export function serviceAddress(
  name: string,
  options?: {
    readonly query?: (name: string) => Promise<Buffer>
    readonly tries?: number
    readonly pauseMs?: number
    readonly sleep?: (milliseconds: number) => Promise<void>
  },
): Promise<string>
export function pinnedLookup(name: string, address: string): LookupFunction
export function pinnedFetch(
  name: string,
  address: string,
  agent?: Agent,
): (input: string | URL, init?: RequestInit & { duplex?: "half" }) => Promise<Response>
export function gatewayTransport(
  gateway: string,
  options?: Parameters<typeof serviceAddress>[1],
): Promise<{
  readonly send: (input: string | URL, init?: RequestInit & { duplex?: "half" }) => Promise<Response>
  readonly lookup: LookupFunction | undefined
  readonly address: string | undefined
}>
