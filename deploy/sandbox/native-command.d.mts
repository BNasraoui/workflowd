export function nativeCommand(args: string[], input: string, options: {
  directory: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<string>
import type { ChildProcess } from "node:child_process"
export interface NativeProcess {
  child: ChildProcess
  closed: Promise<number | null>
}
export function ownNativeProcess(child: ChildProcess): NativeProcess
