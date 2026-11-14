import type { NativeProcess } from "./native-command.mjs"
import type { Readable } from "node:stream"

export function nativeControlLines(input: Readable): AsyncGenerator<string>

export interface NativeSupervisorRequest {
  client?: "codex" | "opencode"
  provider?: string
  nonce: string
  session: string
  deadline: number
  container?: string
  predecessor?: string | null
  resume?: boolean
}
export interface NativeSupervisorEvent {
  event: "started" | "closed"
  nonce: string
  session: string
  outcome?: "completed" | "paused" | "cancelled" | "operator_required"
  stopped?: boolean
}
export function superviseNative<Request extends NativeSupervisorRequest>(input: {
  directory: string
  request: Request
  backend: {
    start(request: Request, signal: AbortSignal): Promise<NativeProcess>
    stop(): Promise<void>
  }
  control: Readable
  event(event: NativeSupervisorEvent): void
}): Promise<"completed" | "paused" | "cancelled" | "operator_required">
