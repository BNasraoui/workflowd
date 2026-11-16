// The one runner of a harness's child processes: the box's docker calls and the seal's result.py.
import { spawn } from "node:child_process"
import { once } from "node:events"

/** The environment of each child process of a harness: a fixed PATH and no home. */
export const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }

/**
 * Writes each chunk of `source` to `sink`, waiting for the sink to drain, then ends it; stops when
 * the sink closes first. (Bun's `pipe` into a child's standard input loses data under backpressure.)
 */
async function feed(source, sink) {
  const closed = once(sink, "close").then(() => false, () => false)
  try {
    for await (const chunk of source) {
      if (sink.write(chunk)) continue
      if (!(await Promise.race([once(sink, "drain").then(() => true, () => false), closed]))) return
    }
    sink.end()
  } catch {
    sink.destroy()
  }
}

/**
 * Runs `binary` with `args` and `input` on its standard input, with a fixed PATH and no home;
 * resolves to its standard output, and fails with the step's name and its last bytes of standard
 * error when it exits other than 0 or outlives `timeoutMs`.
 */
export function command(step, binary, args, { input = "", stdin, timeoutMs = 120000, cwd } = {}) {
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
    // `stdin`, a readable stream, is the standard input in place of `input`.
    if (stdin === undefined) child.stdin.end(input)
    else void feed(stdin, child.stdin)
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
