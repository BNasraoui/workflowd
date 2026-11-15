import { randomBytes, randomUUID } from "node:crypto"
import { dlopen, FFIType } from "bun:ffi"

/** The noscope command contract; the entrypoint owns process lifetime and stdio. */
export function capabilityProvider([operation, ...args]: readonly string[]) {
  // Noscope uses a separate process group. Parent-death signaling ends this
  // adapter if mint is cancelled.
  const parent = process.ppid
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  const attached = parent > 1 && libc.symbols.prctl(1, 9, 0, 0, 0) === 0 && process.ppid === parent
  libc.close()
  if (!attached) throw new Error("capability provider refused")
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
