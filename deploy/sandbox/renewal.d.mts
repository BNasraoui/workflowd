export const renewalReplacements: number
export const renewalRequests: number
export const renewLeadMinMs: number
export const renewLeadMaxMs: number
export const renewalWindowMs: number
export function sessionKeyPair(): { publicKey: string; privateKey: string }
export function isSessionKey(text: unknown): boolean
export function sessionBinder(nonce: string, publicKey: string): string
export const maxRenewalAttempt: number
export const renewalTryMs: number
export const maxRenewalTime: number
export const renewalTimeSkewMs: number
export function isTimelyRenewal(time: unknown, now: number): boolean
export function renewalMessage(
  channel: string,
  predecessor: string,
  attempt: string,
  time: string,
): Buffer
export const maxRenewalBody: number
export function signRenewal(
  privateKey: string,
  channel: string,
  predecessor: string,
  attempt: string,
  time: string,
): string
export function verifyRenewal(
  publicKey: string,
  channel: string,
  predecessor: string,
  attempt: unknown,
  time: unknown,
  signature: unknown,
): boolean
