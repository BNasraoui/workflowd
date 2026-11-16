import { randomUUID } from "node:crypto"
import {
  CustodyRefused,
  custodyFailure,
  custodyProvider,
  forbidCoreFiles,
  loginAccess,
} from "./custody"
import { attachedToParent } from "./parent-death"

/**
 * The noscope provider command of custody: `access <directory> [--token-url <url>] <provider>
 * <ttl>`. It gives the access value as noscope's provider contract asks, or throws. On `stop` it
 * ends as `loginAccess` does: at once, or once a renewal in flight is stored.
 */
export async function custodyCommand(args: ReadonlyArray<string>, stop: AbortSignal) {
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
  const value = await loginAccess(directory, provider, stop, override)
  return {
    token: value.token,
    token_id: randomUUID(),
    expires_at: new Date(Math.min(value.expiresAt, Date.now() + ttl * 1000)).toISOString(),
  }
}

/**
 * Custody's command as its process gives it: the access value on standard output, or a line of
 * standard error that names no value, and the exit status.
 */
export async function custodyRun(args: ReadonlyArray<string>, stop: AbortSignal) {
  try {
    return { code: 0, output: JSON.stringify(await custodyCommand(args, stop)), error: "" }
  } catch (error) {
    return { code: 1, output: "", error: custodyFailure(error) }
  }
}

// Noscope starts the command in its own process group, and custody refuses to run when its parent
// is gone. SIGTERM stops custody, at once or once a renewal in flight is stored: it is the
// parent-death signal, so the end of noscope stops custody, and it is what a service manager
// sends to each process of a stopped unit's control group. Noscope ends at once on SIGTERM, so
// without this a stop of the control group would cut off a renewal and lose its answer.
if (import.meta.main) {
  const stop = new AbortController()
  // The handler comes before the parent-death signal, SIGTERM: none finds the default action.
  process.on("SIGTERM", () => stop.abort())
  let ready = attachedToParent(15)
  // Custody holds login values in memory: before it reads one, it writes no core file.
  try {
    if (ready) forbidCoreFiles()
  } catch {
    ready = false
  }
  const result = ready
    ? await custodyRun(process.argv.slice(2), stop.signal)
    : { code: 1, output: "", error: custodyFailure(new CustodyRefused("refused")) }
  process.stdout.write(result.output)
  process.stderr.write(result.error)
  process.exitCode = result.code
}
