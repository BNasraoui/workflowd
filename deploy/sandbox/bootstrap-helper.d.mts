export interface SessionGrant {
  token: string
  expiresAt: number
  renewAt: number
  deadline: number
  /** The provider id of the model route that the relay calls. */
  providerId: string
  /** The run's channel, which each renewal's signature names. */
  channel: string
  /** The private session key, as PKCS #8 in base64url, which signs each renewal. */
  sessionKey: string
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
  /** The session key that each proof binds, made for this session. */
  sessionKey: { publicKey: string; privateKey: string }
}): Promise<SessionGrant>
export function takeJobIdentity(
  environment: Record<string, string | undefined>,
  send?: (url: URL, init: RequestInit) => Promise<Response>,
  limit?: number,
): JobIdentity
