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
