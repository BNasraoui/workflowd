import { chmod, mkdir, readlink, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { serializePublicStatus } from "../src/sandbox/public-output"
import { suites } from "./capability-suites"

async function main() {
  const args = process.argv.slice(2)
  const suite = args[1]
  const cases = suite === undefined ? undefined : suites[suite]
  if (
    args.length !== 6 ||
    args[0] !== "--suite" ||
    cases === undefined ||
    args[2] !== "--upstream" ||
    args[3] !== "fixture" ||
    args[4] !== "--evidence" ||
    !args[5]
  )
    throw new Error("security invocation refused")
  const host = process.env.WORKFLOWD_FIXTURE_HOST_NETNS
  if (!host || !/^net:\[[0-9]+\]$/.test(host) || host === (await readlink("/proc/self/ns/net")))
    throw new Error("fixture namespace required")
  const directory = resolve(args[5])
  await mkdir(directory, { mode: 0o700 })
  await chmod(directory, 0o700)
  const results = []
  for (const [id, file] of cases) {
    // The empty pattern clears bunfig.toml's launcher exclusion for this one listed file.
    // Coverage gates belong to the plain run; the suites record pass/fail evidence only.
    const command = [process.execPath, "test", "--path-ignore-patterns=", file]
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    let failure: "timeout" | "capacity" | undefined
    const stop = (reason: typeof failure) => {
      failure = reason
      child.kill("SIGKILL")
    }
    const timeout = setTimeout(() => stop("timeout"), 45000)
    let total = 0
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const chunks = []
      for await (const bytes of stream) {
        total += bytes.length
        if (total > 4 * 1048576) {
          stop("capacity")
          break
        }
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString("utf8")
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capture(child.stdout),
      capture(child.stderr),
    ])
    clearTimeout(timeout)
    const output = stdout + stderr
    const passed = Number(/\n\s*(\d+) pass\b/.exec(output)?.[1] ?? 0)
    const assertions = Number(/\n\s*(\d+) expect\(\) calls/.exec(output)?.[1] ?? 0)
    const ok =
      exitCode === 0 &&
      !failure &&
      passed > 0 &&
      /\n\s*0 fail\b/.test(output) &&
      !/\n\s*[1-9]\d* (?:skip|todo|filtered out)\b/.test(output)
    await writeFile(join(directory, `${id}.log`), output, { mode: 0o600 })
    results.push({ id, file, command, exitCode, passed, assertions, ok, failure })
    // IDs come exclusively from this reviewed list; child diagnostics never enter this sink.
    process.stdout.write(
      `${id} ${serializePublicStatus({ stage: "test", outcome: ok ? "ok" : "failed", reason: ok ? "none" : (failure ?? "unavailable"), count: passed })}\n`,
    )
  }
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(
      {
        version: 1,
        suite,
        results,
        completeCoreCases: suite === "core" && results.every((result) => result.ok),
        completeListedCases: results.every((result) => result.ok),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

if (import.meta.main)
  await main().catch(() => {
    process.stdout.write(
      serializePublicStatus({ stage: "test", outcome: "failed", reason: "refused", count: 0 }) +
        "\n",
    )
    process.exitCode = 1
  })
