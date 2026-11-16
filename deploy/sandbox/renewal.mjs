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

/**
 * True when `text` is a session's public key: the base64url form of an Ed25519 key's 32 bytes.
 * A key of small order, for which anyone can make a valid signature, is not refused, as the
 * crypto of the runtime gives no check of the subgroup; it does not matter here, because the
 * runner's own proof binds the key, so only the runner chooses it, and a runner that chose such
 * a key could as well give its private key away.
 */
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

/**
 * The attempt number of a renewal request, as its exact decimal text. The relay numbers each
 * renewal request of its session 1, 2, 3, …, a retry too, and the gateway takes a renewal only
 * when its number is higher than each that it took before for the session; so a copy of a signed
 * request, sent again, renews nothing and ends nothing. The text has no sign, no leading zero and
 * at most nine digits: the bound, 999999999, is far above the requests of any run, which sends
 * at most `renewalRequests` of them for each run token, and a run token lives minutes.
 */
export const maxRenewalAttempt = 999999999
function isRenewalAttempt(text) {
  return typeof text === "string" && /^[1-9][0-9]{0,8}$/.test(text)
}

/**
 * The exact bytes that the relay signs to renew the run token whose digest is `predecessor`, as
 * its request numbered `attempt` of the session.
 */
export function renewalMessage(channel, predecessor, attempt) {
  return Buffer.from(`workflowd-renew:${channel}:${predecessor}:${attempt}`, "utf8")
}

/**
 * The renewal's body is `{"signature":"<signature>","attempt":"<attempt>"}`; the gateway reads at
 * most this many bytes.
 */
export const maxRenewalBody = 128

/**
 * The relay's signature, in base64url, of its renewal request numbered `attempt` of
 * `predecessor` on `channel`. It throws when `privateKey` is not an Ed25519 key as PKCS #8 in
 * base64url, or when `attempt` is not an attempt number.
 */
export function signRenewal(privateKey, channel, predecessor, attempt) {
  if (!isRenewalAttempt(attempt)) throw new Error("renewal attempt refused")
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("session key refused")
  return sign(null, renewalMessage(channel, predecessor, attempt), key).toString("base64url")
}

/**
 * True when `attempt` is an attempt number and `signature` is the base64url form of exactly 64
 * bytes and an Ed25519 signature by `publicKey` of the renewal request numbered `attempt` of
 * `predecessor` on `channel`.
 */
export function verifyRenewal(publicKey, channel, predecessor, attempt, signature) {
  const key = publicSessionKey(publicKey)
  const bytes = exactBytes(signature, 64)
  return (
    isRenewalAttempt(attempt) &&
    key !== undefined &&
    bytes !== undefined &&
    verify(null, renewalMessage(channel, predecessor, attempt), key, bytes)
  )
}

/**
 * The run routes that carry a body: the relay signs each such request with the session key, over
 * the SHA-256 of the exact body bytes, under a prefix of its own, so that no renewal signature is
 * a run signature and no signature of one route or body is one of another. The signature goes in
 * the header `runSignatureHeader`.
 */
export const runSignedRoutes = ["events", "result"]
export const runSignatureHeader = "x-workflowd-run-signature"

/** The exact bytes that the relay signs to send `body` (its SHA-256 hex) on run route `route`. */
export function runMessage(channel, route, bodyDigest) {
  return Buffer.from(`workflowd-run:${channel}:${route}:${bodyDigest}`, "utf8")
}

/** The SHA-256 hex of a body's bytes. */
export function bodyDigest(body) {
  return createHash("sha256").update(body).digest("hex")
}

/** The relay's signature, in base64url, of `body` on run route `route` of `channel`. */
export function signRunBody(privateKey, channel, route, body) {
  if (!runSignedRoutes.includes(route)) throw new Error("run route refused")
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("session key refused")
  return sign(null, runMessage(channel, route, bodyDigest(body)), key).toString("base64url")
}

/**
 * True when `signature` is the base64url form of exactly 64 bytes and an Ed25519 signature by
 * `publicKey` of the body whose SHA-256 hex is `digest` on run route `route` of `channel`.
 */
export function verifyRunBody(publicKey, channel, route, digest, signature) {
  const key = publicSessionKey(publicKey)
  const bytes = exactBytes(signature, 64)
  return (
    runSignedRoutes.includes(route) &&
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/.test(digest) &&
    key !== undefined &&
    bytes !== undefined &&
    verify(null, runMessage(channel, route, digest), key, bytes)
  )
}
