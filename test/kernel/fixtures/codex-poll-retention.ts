import { heapStats } from "bun:jsc"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeCodexCli } from "../../../src/kernel/codex-session"
const root = await mkdtemp(join(tmpdir(), "pr57-poll-retention-"))
let description = ""
let polling = false
let polls = 0
const samples: number[] = []
const cli = makeCodexCli({
  binary: "unused",
  custodyRoot: root,
  pollIntervalMs: 0,
  observationTimeoutMs: 60_000,
  cancellationGraceMs: 60_000,
  runCommand: async (command: ReadonlyArray<string>) => {
    if (command[0] === "systemd-run")
      description = command.find((v) => v.startsWith("--description="))?.slice(14) ?? ""
    if (command.includes("stop")) polling = true
    if (command.includes("show")) {
      if (polling) {
        polls++
        if (polls === 200 || polls === 1200) {
          Bun.gc(true)
          samples.push(heapStats().objectTypeCounts.Promise ?? 0)
        }
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: `MainPID=12345\nInvocationID=fixture\nDescription=${description}\nActiveState=${polls >= 1200 ? "inactive" : "active"}\n`,
      }
    }
    return { exitCode: 0, stderr: "", stdout: "" }
  },
})
try {
  const process = await Effect.runPromise(
    cli.spawn({ runId: "agent-run-retention", directory: root, prompt: "unused", model: null }),
  )
  if (Bun.argv[2] === "cancel") await Effect.runPromise(process.cancel)
  else {
    polling = true
    await Effect.runPromise(process.exited)
  }
  console.log(
    JSON.stringify({
      mode: Bun.argv[2] ?? "exit",
      polls,
      samples,
      growth: samples[1]! - samples[0]!,
    }),
  )
  if (samples[1]! - samples[0]! > 100)
    throw new Error("Polling retains promises in proportion to poll count")
} finally {
  await rm(root, { recursive: true, force: true })
}
