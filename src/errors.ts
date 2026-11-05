export function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/**
 * A manager query or host request that got no answer: a killed or timed-out
 * `systemctl`, or an unreachable host socket. It says nothing about the
 * process, so its observer may re-attach. Every other observation failure is
 * evidence (custody or identity changed, a record failed to decode).
 */
export class ObservationUnavailableError extends Error {
  override readonly name = "ObservationUnavailableError"
}
