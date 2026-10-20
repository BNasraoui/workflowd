import { readFile, readdir, readlink, realpath } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

const gone = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

async function matchesEntrypoint(pid: number, executable: string, entry: string) {
  if ((await readlink(`/proc/${pid}/exe`)) !== executable) return false
  const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean)
  const cwd = await readlink(`/proc/${pid}/cwd`)
  const paths = await Promise.all(
    args
      .slice(1)
      .filter((arg) => basename(arg) === basename(entry))
      .map((arg) => realpath(resolve(cwd, arg))),
  )
  return paths.includes(entry)
}

async function children(pid: number): Promise<number[]> {
  const threads = await readdir(`/proc/${pid}/task`)
  const lists = await Promise.all(
    threads.map(async (thread) => {
      try {
        const value = await readFile(`/proc/${pid}/task/${thread}/children`, "utf8")
        return value.trim().split(/\s+/).filter(Boolean).map(Number)
      } catch (cause) {
        if (!gone(cause)) throw cause
        return []
      }
    }),
  )
  return lists.flat()
}

async function candidatesBelow(pid: number, executable: string, entry: string): Promise<number[]> {
  try {
    const [matches, descendants] = await Promise.all([
      matchesEntrypoint(pid, executable, entry),
      children(pid).then((pids) =>
        Promise.all(pids.map((child) => candidatesBelow(child, executable, entry))),
      ),
    ])
    return [...(matches ? [pid] : []), ...descendants.flat()]
  } catch (cause) {
    if (!gone(cause)) throw cause
    return []
  }
}

/** Signal only the matching Bun daemon, never noscope or a process group. */
export async function signalWorkflowdReload(
  mainPid: number,
  entrypoint = join(import.meta.dir, "main.ts"),
) {
  if (!Number.isSafeInteger(mainPid) || mainPid <= 1) throw new Error("Invalid main PID")
  const entry = await realpath(entrypoint)
  const executable = await realpath(process.execPath)
  const candidates = await candidatesBelow(mainPid, executable, entry)
  if (candidates.length !== 1) throw new Error("Expected one workflowd process below the main PID")
  const pid = candidates[0]!
  const status = await readFile(`/proc/${pid}/status`, "utf8")
  const caught = /^SigCgt:\s*([0-9a-f]+)$/im.exec(status)?.[1]
  if (caught === undefined || (BigInt(`0x${caught}`) & 1n) === 0n)
    throw new Error("Workflowd has no SIGHUP handler")
  process.kill(pid, "SIGHUP")
}

if (import.meta.main) {
  await signalWorkflowdReload(Number(process.argv[2])).catch(() => {
    console.error("Could not identify and signal one workflowd process")
    process.exitCode = 1
  })
}
