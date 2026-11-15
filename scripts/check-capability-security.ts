import { readlink } from "node:fs/promises"
import { suiteReport, suites } from "./capability-suites"

/**
 * Runs each test file of one suite in its own `bun test`, and prints the number of cases that
 * ran and the name of each case that failed. A case fails when its run does not exit 0, ends
 * at its time or output limit, passes no test, or reports a failed, skipped or todo test.
 */
async function main() {
  const args = process.argv.slice(2)
  const suite = args[1]
  const cases = suite === undefined ? undefined : suites[suite]
  if (args.length !== 2 || args[0] !== "--suite" || cases === undefined)
    throw new Error("usage: check-capability-security.ts --suite <name>")
  const host = process.env.WORKFLOWD_FIXTURE_HOST_NETNS
  if (!host || !/^net:\[[0-9]+\]$/.test(host) || host === (await readlink("/proc/self/ns/net")))
    throw new Error("fixture namespace required")
  const failed: string[] = []
  for (const file of cases) {
    // The empty pattern clears bunfig.toml's launcher exclusion for this one listed file.
    const child = Bun.spawn([process.execPath, "test", "--path-ignore-patterns=", file], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let stopped = false
    const stop = () => {
      stopped = true
      child.kill("SIGKILL")
    }
    const timeout = setTimeout(stop, 45000)
    let total = 0
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const chunks = []
      for await (const bytes of stream) {
        total += bytes.length
        if (total > 4 * 1048576) {
          stop()
          break
        }
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString("utf8")
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      read(child.stdout),
      read(child.stderr),
    ])
    clearTimeout(timeout)
    const output = stdout + stderr
    const ok =
      exitCode === 0 &&
      !stopped &&
      Number(/\n\s*(\d+) pass\b/.exec(output)?.[1] ?? 0) > 0 &&
      /\n\s*0 fail\b/.test(output) &&
      !/\n\s*[1-9]\d* (?:skip|todo|filtered out)\b/.test(output)
    if (!ok) failed.push(file)
  }
  const report = suiteReport(suite, cases, failed)
  for (const line of report.lines) process.stdout.write(`${line}\n`)
  process.exitCode = report.exitCode
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    process.stdout.write(`${error instanceof Error ? error.message : "refused"}\n`)
    process.exitCode = 1
  })
