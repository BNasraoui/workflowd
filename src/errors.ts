export function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/**
 * The name of an observation failure that is evidence about a process or its
 * custody: the unit is not found, its identity or the host's custody changed, or
 * a custody record failed to decode. Its observer must not re-attach. Any other
 * manager, bus or host failure says nothing about the process and may be retried.
 * A name rather than a class keeps this module free of uncovered functions where
 * the agent host client is loaded alone.
 */
export const OBSERVATION_EVIDENCE = "ObservationEvidenceError"
