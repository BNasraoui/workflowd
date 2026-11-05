export function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/**
 * An observation failure that is evidence about a process or its custody: the
 * unit is not found, its identity or the host's custody changed, or a custody
 * record failed to decode. Its observer must not re-attach. Any other manager,
 * bus or host failure says nothing about the process and may be retried.
 */
export class ObservationEvidenceError extends Error {
  override readonly name = "ObservationEvidenceError"
}
