// The one runner of a harness's child processes: the box's docker calls and the seal's result.py.
import { spawn } from "node:child_process"

/** The environment of each child process of a harness: a fixed PATH and no home. */
export const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }

/**
 * Runs `binary` with `args` and `input` on its standard input, with a fixed PATH and no home;
 * resolves to its standard output, and fails with the step's name and its last bytes of standard
 * error when it exits other than 0 or outlives `timeoutMs`.
 */
export function command(step, binary, args, { input = "", timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: environment, cwd, stdio: ["pipe", "pipe", "pipe"] })
    const output = []
    let size = 0
    let errors = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (bytes) => {
      size += bytes.length
      if (size > 1048576) child.kill("SIGKILL")
      else output.push(bytes)
    })
    child.stderr.on("data", (bytes) => {
      errors = (errors + bytes.toString("utf8")).slice(-2000)
    })
    child.stdin.on("error", () => undefined)
    child.stdin.end(input)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`${step}: ${error.message}`))
    })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"))
      else reject(new Error(`${step}: exit ${code ?? signal}: ${errors.trim()}`))
    })
  })
}
