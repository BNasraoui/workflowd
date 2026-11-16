import { randomBytes, randomUUID } from "node:crypto"
import { attachedToParent } from "./parent-death"

/** The noscope command contract; the entrypoint owns process lifetime and stdio. */
export function capabilityProvider([operation, ...args]: readonly string[]) {
  // Parent-death signaling (SIGKILL) ends this adapter if mint is cancelled.
  if (!attachedToParent(9)) throw new Error("capability provider refused")
  const ttl = Number(args.at(-1))
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600)
    throw new Error("capability provider refused")
  if (operation !== "run" || args.length !== 1) throw new Error("capability provider refused")
  return {
    token: randomBytes(32).toString("base64url"),
    token_id: randomUUID(),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  }
}

// Invoked only by an explicitly installed owner-only noscope provider configuration.
// Run material has no authority until workflowd commits its digest and exact binding.
if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(capabilityProvider(process.argv.slice(2))))
  } catch {
    process.stderr.write("capability provider refused\n")
    process.exitCode = 1
  }
}
