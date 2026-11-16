import { sessionKeyPair } from "../../../deploy/sandbox/renewal.mjs"

/**
 * The config of a relay whose clock reads `now`, for a gateway on loopback `port`: a token that
 * renews 45 minutes in and expires an hour in, within a two-hour run, and a new session key.
 */
export function relayConfig(now, port) {
  return {
    token: "a".repeat(43),
    channel: "c".repeat(64),
    sessionKey: sessionKeyPair().privateKey,
    expiresAt: now + 3600000,
    renewAt: now + 2700000,
    deadline: now + 7200000,
    providerId: "anthropic",
    gateway: `https://127.0.0.1:${port}`,
  }
}
