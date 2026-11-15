export interface SessionGrant {
  token: string
  expiresAt: number
  renewAt: number
  deadline: number
}
export type JobIdentity = ((audience: string, signal: AbortSignal) => Promise<string>) & {
  clear: () => void
}
export function gatewayOrigin(value: string): string
export function openSession(options: {
  gateway: string
  leaseId: string
  issue: (audience: string, signal: AbortSignal) => Promise<string>
  send?: (url: URL, init: RequestInit) => Promise<Response>
  attempts?: number
  backoff?: (attempt: number) => number
  signal?: AbortSignal
}): Promise<SessionGrant>
export function takeJobIdentity(
  environment: Record<string, string | undefined>,
  send?: (url: URL, init: RequestInit) => Promise<Response>,
  limit?: number,
): JobIdentity
