import { randomUUID } from "node:crypto"

// The only two bootstrap fields that may appear in the public job log. They come from the
// trusted caller's configuration.
export const publicBootstrapFields = {
  tailscaleClientId: /^[A-Za-z0-9_-]{1,128}$/,
  tailscaleAudience: /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/,
}
export function publicBootstrapConfiguration(input) {
  const output = {}
  for (const [field, pattern] of Object.entries(publicBootstrapFields)) {
    if (typeof input[field] !== "string" || !pattern.test(input[field]))
      throw new Error("bootstrap configuration refused")
    output[field] = input[field]
  }
  return output
}

/** Controlled public sinks accept metadata, never arbitrary diagnostic text. */
export function serializePublicStatus(input) {
  const { stage, outcome, reason, count = 0 } = input
  if (
    !["setup", "bootstrap", "audit", "transport", "cleanup", "test"].includes(stage) ||
    !["ok", "failed", "cancelled"].includes(outcome) ||
    ![
      "none",
      "refused",
      "unavailable",
      "timeout",
      "capacity",
      "renewal",
      "expiry",
      "deadline",
    ].includes(reason) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 1000000000
  )
    throw new Error("public status refused")
  return JSON.stringify({ version: 1, stage, outcome, reason, count, correlationId: randomUUID() })
}
