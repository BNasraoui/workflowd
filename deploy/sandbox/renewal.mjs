import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"

/**
 * The one count of a run token's renewal, read by the gateway and by the runner's relay. The
 * gateway grants one successor of a run token and, when the renewal is asked again because its
 * answer was lost, replaces that successor at most `renewalReplacements` times. The relay asks
 * one renewal at most `renewalRequests` times, so it never asks more often than the gateway
 * permits; when the last of them fails, the relay ends the session.
 */
export const renewalReplacements = 3
export const renewalRequests = renewalReplacements + 1
/** The holder of a run token renews it between these many milliseconds before it expires. */
export const renewLeadMinMs = 180000
export const renewLeadMaxMs = 300000
/** The gateway renews a token only this close to its expiry: the latest lead and 30 s of slack. */
export const renewalWindowMs = renewLeadMaxMs + 30000

/**
 * The session key of a run: an Ed25519 key pair that the runner's helper makes before it opens
 * the session. The public key, as its 32 bytes in base64url, is the only part that goes to the
 * gateway; the private key, as PKCS #8 in base64url, goes to the relay alone and signs each
 * renewal.
 */
export function sessionKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKey: publicKey.export({ format: "jwk" }).x,
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  }
}

/** The bytes of `text` when it is the base64url form of exactly `length` bytes, else undefined. */
function exactBytes(text, length) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return undefined
  const bytes = Buffer.from(text, "base64url")
  return bytes.length === length && bytes.toString("base64url") === text ? bytes : undefined
}

/** True when `text` is a session's public key: the base64url form of an Ed25519 key's 32 bytes. */
export function isSessionKey(text) {
  return publicSessionKey(text) !== undefined
}

function publicSessionKey(text) {
  if (exactBytes(text, 32) === undefined) return undefined
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: text }, format: "jwk" })
  } catch {
    return undefined
  }
}

/**
 * The binder of a session: SHA-256 hex of the gateway's nonce and the public key. The runner's
 * proof names it in its audience, `workflowd:<channel>:<binder>`, so the proof holds the key.
 */
export function sessionBinder(nonce, publicKey) {
  return createHash("sha256").update(`${nonce}:${publicKey}`).digest("hex")
}

/** The exact bytes that the relay signs to renew the run token whose digest is `predecessor`. */
export function renewalMessage(channel, predecessor) {
  return Buffer.from(`workflowd-renew:${channel}:${predecessor}`, "utf8")
}

/** The renewal's body is `{"signature":"<signature>"}`; the gateway reads at most this many bytes. */
export const maxRenewalBody = 128

/**
 * The relay's signature, in base64url, of the renewal of `predecessor` on `channel`. It throws
 * when `privateKey` is not an Ed25519 key as PKCS #8 in base64url.
 */
export function signRenewal(privateKey, channel, predecessor) {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("session key refused")
  return sign(null, renewalMessage(channel, predecessor), key).toString("base64url")
}

/**
 * True when `signature` is the base64url form of exactly 64 bytes and an Ed25519 signature by
 * `publicKey` of the renewal of `predecessor` on `channel`.
 */
export function verifyRenewal(publicKey, channel, predecessor, signature) {
  const key = publicSessionKey(publicKey)
  const bytes = exactBytes(signature, 64)
  return (
    key !== undefined &&
    bytes !== undefined &&
    verify(null, renewalMessage(channel, predecessor), key, bytes)
  )
}
