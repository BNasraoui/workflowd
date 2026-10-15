import { readFileSync, readlinkSync } from "node:fs"

const host = () => readFileSync("/etc/machine-id", "utf8").trim()
const boot = () =>
  readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replaceAll("-", "")
const namespace = () => readlinkSync("/proc/self/ns/pid").replace(/\D/g, "")
const identity = (pid: number) => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  return { state: fields[0], start: fields[19] }
}

export const owner = () =>
  [
    "v1",
    host(),
    process.getuid!(),
    boot(),
    namespace(),
    process.pid,
    identity(process.pid).start,
  ].join(".")

/** Unknown ownership is never authority to delete. Include boot, namespace and start ticks to fence PID reuse. */
export function ownerState(id: string | undefined): "alive" | "dead" | "unknown" {
  if (!id || !/^v1\.[a-f0-9]{32}\.\d+\.[a-f0-9]{32}\.\d+\.[1-9]\d*\.\d+$/.test(id)) return "unknown"
  const [, machine, uid, bootId, ns, pid, start] = id.split(".")
  if (machine !== host() || uid !== String(process.getuid!())) return "unknown"
  if (bootId !== boot()) return "dead"
  if (ns !== namespace()) return "unknown"
  try {
    const current = identity(Number(pid))
    return current.start !== start || current.state === "Z" || current.state === "X"
      ? "dead"
      : "alive"
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "dead" : "unknown"
  }
}
