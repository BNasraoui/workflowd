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
 * The relay ends one renewal request after this many milliseconds without a byte, both while it
 * connects and while it waits for the answer: a single try that the relay can still read the
 * answer of lasts at most twice this long.
 */
export const renewalTryMs = 10000

/**
 * The time of a renewal request: the relay's clock when it signed the request, in whole seconds
 * since the epoch, as its exact decimal text. The text has no sign, no leading zero and at most
 * ten digits: the bound, 9999999999, is the year 2286.
 */
export const maxRenewalTime = 9999999999
function isRenewalTime(text) {
  return typeof text === "string" && /^[1-9][0-9]{0,9}$/.test(text)
}

/**
 * The gateway takes a renewal only when its time is at most this many milliseconds before or
 * after the gateway's own clock, so a signed request that the gateway refused or could not serve
 * is void a minute after the relay signed it. 60 s is longer than what an honest request needs:
 * the relay's longest single try, two times `renewalTryMs` (20 s), and an honest difference
 * between the clocks of a GitHub runner and of the gateway's host, which the renewal window
 * already bounds by its 30 s of slack over the relay's latest lead (`renewalWindowMs -
 * renewLeadMaxMs`); 20 s + 30 s is 50 s. It is far shorter than the 570 s for which a new run
 * token is renewed by no request (its life of 900 s less `renewalWindowMs`), so a request that
 * was refused because it came too early is void long before the token's window opens.
 */
export const renewalTimeSkewMs = 60000

/**
 * True when `time` is the time of a renewal request and is at most `renewalTimeSkewMs` from
 * `now`, the gateway's clock in milliseconds.
 */
export function isTimelyRenewal(time, now) {
  return isRenewalTime(time) && Math.abs(now - Number(time) * 1000) <= renewalTimeSkewMs
}

/**
 * The exact bytes that the relay signs to renew the run token whose digest is `predecessor`, as
 * its request numbered `attempt` of the session, signed at `time`.
 */
export function renewalMessage(channel, predecessor, attempt, time) {
  return Buffer.from(`workflowd-renew:${channel}:${predecessor}:${attempt}:${time}`, "utf8")
}

/**
 * The renewal's body is `{"signature":"<signature>","attempt":"<attempt>","time":"<time>"}`; the
 * gateway reads at most this many bytes, the length of the body with an attempt number and a time
 * of the most digits.
 */
export const maxRenewalBody = 144

/**
 * The relay's signature, in base64url, of its renewal request numbered `attempt` of
 * `predecessor` on `channel`, signed at `time`. It throws when `privateKey` is not an Ed25519 key
 * as PKCS #8 in base64url, when `attempt` is not an attempt number, or when `time` is not a time.
 */
export function signRenewal(privateKey, channel, predecessor, attempt, time) {
  if (!isRenewalAttempt(attempt)) throw new Error("renewal attempt refused")
  if (!isRenewalTime(time)) throw new Error("renewal time refused")
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("session key refused")
  return sign(null, renewalMessage(channel, predecessor, attempt, time), key).toString("base64url")
}

/**
 * True when `attempt` is an attempt number, `time` is a time, and `signature` is the base64url
 * form of exactly 64 bytes and an Ed25519 signature by `publicKey` of the renewal request
 * numbered `attempt` of `predecessor` on `channel`, signed at `time`.
 */
export function verifyRenewal(publicKey, channel, predecessor, attempt, time, signature) {
  const key = publicSessionKey(publicKey)
  const bytes = exactBytes(signature, 64)
  return (
    isRenewalAttempt(attempt) &&
    isRenewalTime(time) &&
    key !== undefined &&
    bytes !== undefined &&
    verify(null, renewalMessage(channel, predecessor, attempt, time), key, bytes)
  )
}
