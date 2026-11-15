/**
 * The one count of a run token's renewal, read by the gateway and by the runner's relay. The
 * gateway grants one successor of a run token and, when the renewal is asked again because its
 * answer was lost, replaces that successor at most `renewalReplacements` times. The relay asks
 * one renewal at most `renewalRequests` times, so it never asks more often than the gateway
 * permits; when the last of them fails, the relay ends the session.
 */
export const renewalReplacements = 3
export const renewalRequests = renewalReplacements + 1
