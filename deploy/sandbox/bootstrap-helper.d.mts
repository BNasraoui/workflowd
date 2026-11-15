export interface SessionGrant {
  token: string
  expiresAt: number
  renewAt: number
  deadline: number
  /** The provider id of the model route that the relay calls. */
  providerId: string
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
  /** How long, in all, a challenge that is not ready (503 or a network error) is waited for. */
  wait?: number
  waitBackoff?: (waited: number) => number
  clock?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}): Promise<SessionGrant>
export function takeJobIdentity(
  environment: Record<string, string | undefined>,
  send?: (url: URL, init: RequestInit) => Promise<Response>,
  limit?: number,
): JobIdentity
