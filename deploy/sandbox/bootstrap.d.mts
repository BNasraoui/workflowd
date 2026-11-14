export function serveBootstrap(options: {
  directory: string
  identity: { peerId: string; agentImage: string; workflowSha: string }
  issue: (audience: string, signal: AbortSignal) => Promise<string>
  activate: (grant: Record<string, unknown>, signal: AbortSignal) => Promise<void>
  timeoutMs?: number
}): Promise<{ completed: Promise<void>; close: () => void }>
export function takeJobIdentity(
  environment: Record<string, string | undefined>,
  send?: (url: URL, init: RequestInit) => Promise<Response>,
): (audience: string, signal: AbortSignal) => Promise<string>
