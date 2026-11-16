import { randomUUID } from "node:crypto"
import { dlopen, FFIType } from "bun:ffi"
import {
  CustodyRefused,
  custodyFailure,
  custodyProvider,
  forbidCoreFiles,
  loginAccess,
} from "./custody"

/**
 * The noscope provider command of custody: `access <directory> [--token-url <url>] <provider>
 * <ttl>`. It prints the access value as noscope's provider contract asks, or throws.
 */
export async function custodyCommand(args: ReadonlyArray<string>) {
  const [operation, directory, ...rest] = args
  const override = rest[0] === "--token-url" ? rest[1] : undefined
  const [name, ttlText, ...extra] = override === undefined ? rest : rest.slice(2)
  const provider = custodyProvider(name ?? "")
  const ttl = Number(ttlText)
  if (
    operation !== "access" ||
    !directory?.startsWith("/") ||
    !provider ||
    extra.length > 0 ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 3600
  )
    throw new CustodyRefused("refused")
  const value = await loginAccess(directory, provider, override)
  return {
    token: value.token,
    token_id: randomUUID(),
    expires_at: new Date(Math.min(value.expiresAt, Date.now() + ttl * 1000)).toISOString(),
  }
}

// Noscope starts the command in its own process group: parent-death signaling ends it with
// noscope, and it refuses to run when its parent is gone.
if (import.meta.main) {
  const parent = process.ppid
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  // PR_SET_PDEATHSIG, SIGKILL
  const attached = parent > 1 && libc.symbols.prctl(1, 9, 0, 0, 0) === 0 && process.ppid === parent
  libc.close()
  try {
    if (!attached) throw new CustodyRefused("refused")
    forbidCoreFiles()
    process.stdout.write(JSON.stringify(await custodyCommand(process.argv.slice(2))))
  } catch (error) {
    process.stderr.write(custodyFailure(error))
    process.exitCode = 1
  }
}
