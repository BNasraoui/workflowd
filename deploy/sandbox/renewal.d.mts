export const renewalReplacements: number
export const renewalRequests: number
export const renewLeadMinMs: number
export const renewLeadMaxMs: number
export const renewalWindowMs: number
export function sessionKeyPair(): { publicKey: string; privateKey: string }
export function isSessionKey(text: unknown): boolean
export function sessionBinder(nonce: string, publicKey: string): string
export const maxRenewalAttempt: number
export function renewalMessage(channel: string, predecessor: string, attempt: string): Buffer
export const maxRenewalBody: number
export function signRenewal(
  privateKey: string,
  channel: string,
  predecessor: string,
  attempt: string,
): string
export function verifyRenewal(
  publicKey: string,
  channel: string,
  predecessor: string,
  attempt: unknown,
  signature: unknown,
): boolean
export const runSignedRoutes: ReadonlyArray<string>
export const runSignatureHeader: string
export function runMessage(channel: string, route: string, bodyDigest: string): Buffer
export function bodyDigest(body: Uint8Array | string): string
export function signRunBody(
  privateKey: string,
  channel: string,
  route: string,
  body: Uint8Array | string,
): string
export function verifyRunBody(
  publicKey: string,
  channel: string,
  route: string,
  digest: unknown,
  signature: unknown,
): boolean
