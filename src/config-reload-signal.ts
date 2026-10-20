import { readFile, readlink, realpath } from "node:fs/promises"
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

/** Signal only the matching Bun daemon, never noscope or a process group. */
export async function signalWorkflowdReload(
  mainPid: number,
  entrypoint = join(import.meta.dir, "main.ts"),
) {
  if (!Number.isSafeInteger(mainPid) || mainPid <= 1) throw new Error("Invalid main PID")
  const entry = await realpath(entrypoint)
  const executable = await realpath(process.execPath)
  const candidates: number[] = []
  const pending = [mainPid]
  while (pending.length > 0) {
    const pid = pending.pop()!
    try {
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")
      pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number))
      if (await matchesEntrypoint(pid, executable, entry)) candidates.push(pid)
    } catch (cause) {
      if (!gone(cause)) throw cause
    }
  }
  if (candidates.length !== 1) throw new Error("Expected one workflowd process below the main PID")
  process.kill(candidates[0]!, "SIGHUP")
}

if (import.meta.main) {
  await signalWorkflowdReload(Number(process.argv[2])).catch(() => {
    console.error("Could not identify and signal one workflowd process")
    process.exitCode = 1
  })
}
