import type { ChildProcess } from "node:child_process"
import type { NativeSupervisorRequest } from "./native-supervisor.mjs"
import type { NativeProcess } from "./native-command.mjs"

interface Engine {
  command(args: string[], input?: Uint8Array): Promise<string>
  spawn(args: string[]): ChildProcess
  spawnCustodian(client?: "codex" | "opencode"): ChildProcess
}
export function makeNativeDockerBackend(config: { directory: string; image: string; nonce: string }, engine?: Engine): {
  start(request: NativeSupervisorRequest & { model: string; effort: string; prompt: string }, signal?: AbortSignal): Promise<NativeProcess>
  stop(options?: { cancelPending?: boolean }): Promise<void>
  exportWorkspace(): Promise<void>
  remove(): Promise<void>
}
