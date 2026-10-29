import { readFile, readdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, normalize } from "node:path"

class ReloadRefused extends Error {}

const unavailable = (cause: unknown) =>
  cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "EACCES")

async function matchesEntrypoint(pid: number, entry: string) {
  try {
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")
    // Inspect the script position, never arguments to noscope, `bun run`, or another script.
    if (basename(args[0] ?? "") !== basename(process.execPath) || !args[1]) return false
    const script = normalize(args[1])
    return isAbsolute(script) ? script === entry : entry.endsWith(`/${script}`)
  } catch (cause) {
    if (!unavailable(cause)) throw cause
    return false
  }
}

async function children(pid: number): Promise<number[]> {
  try {
    const threads = await readdir(`/proc/${pid}/task`)
    const lists = await Promise.all(
      threads.map(async (thread) => {
        try {
          const value = await readFile(`/proc/${pid}/task/${thread}/children`, "utf8")
          return value.trim().split(/\s+/).filter(Boolean).map(Number)
        } catch (cause) {
          if (!unavailable(cause)) throw cause
          return []
        }
      }),
    )
    return lists.flat()
  } catch (cause) {
    if (!unavailable(cause)) throw cause
    return []
  }
}

async function candidatesBelow(
  pid: number,
  entry: string,
  seen = new Set<number>(),
): Promise<number[]> {
  if (seen.has(pid)) return []
  seen.add(pid)
  // A denied cmdline on a wrapper must not prevent traversal of its children.
  const [matches, descendants] = await Promise.all([
    matchesEntrypoint(pid, entry),
    children(pid).then((pids) =>
      Promise.all(pids.map((child) => candidatesBelow(child, entry, seen))),
    ),
  ])
  return [...(matches ? [pid] : []), ...descendants.flat()]
}

/** Signal exactly one Bun entrypoint with a caught HUP, using no ptrace-gated proc links. */
export async function signalWorkflowdReload(
  mainPid: number,
  entrypoint = join(import.meta.dir, "main.ts"),
) {
  if (!Number.isSafeInteger(mainPid) || mainPid <= 1) throw new ReloadRefused("Invalid main PID")
  const candidates = await candidatesBelow(mainPid, await realpath(entrypoint))
  if (candidates.length === 0)
    throw new ReloadRefused("No workflowd process matched below the main PID")
  if (candidates.length > 1)
    throw new ReloadRefused("Several workflowd processes matched below the main PID")
  const pid = candidates[0]!
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => {
    throw new ReloadRefused("Could not read workflowd SIGHUP handler status")
  })
  const caught = /^SigCgt:\s*([0-9a-f]+)$/im.exec(status)?.[1]
  if (caught === undefined || (BigInt(`0x${caught}`) & 1n) === 0n)
    throw new ReloadRefused("Workflowd has no SIGHUP handler")
  process.kill(pid, "SIGHUP")
}

if (import.meta.main) {
  await signalWorkflowdReload(Number(process.argv[2])).catch((cause: unknown) => {
    // Raw OS errors may include paths or command arguments containing secrets.
    const reason =
      cause instanceof ReloadRefused
        ? cause.message
        : "Process inspection or signal delivery failed"
    console.error(`Could not reload workflowd: ${reason}`)
    process.exitCode = 1
  })
}
