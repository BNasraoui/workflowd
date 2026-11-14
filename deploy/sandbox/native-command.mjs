import { spawn } from "node:child_process"

const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }

/** Install at acquisition, before any input or asynchronous ownership handoff. */
export function ownNativeProcess(child) {
  let failed = false
  const fail = () => { failed = true; child.kill("SIGKILL") }
  child.on("error", fail)
  child.stdin.on("error", fail)
  // Non-rejecting: an early failure cannot become an unhandled rejection while
  // the acquiring backend is releasing its lock. Close joins the owned pipes.
  const closed = new Promise(resolve => child.once("close", code => resolve(failed ? -1 : code)))
  return { child, closed }
}

export async function nativeCommand(args, input, { directory, timeoutMs = 90000, signal }) {
  signal?.throwIfAborted()
  const child = spawn(args[0], args.slice(1), { cwd: directory, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] })
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  const stop = () => {
    try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
  }
  signal?.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(stop, timeoutMs)
  child.stdin.on("error", () => {})
  child.stdin.end(input)
  const collect = async (stream) => {
    let size = 0
    const chunks = []
    for await (const chunk of stream) {
      size += chunk.length
      if (size > 262144) throw new Error("Native operation output capacity")
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  try {
    const [code, output] = await Promise.all([closed, collect(child.stdout), collect(child.stderr)])
    signal?.throwIfAborted()
    if (code !== 0) throw new Error("Native operation failed")
    return output.trim()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    stop()
    await closed
  }
}
