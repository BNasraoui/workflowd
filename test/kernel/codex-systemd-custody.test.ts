import { expect, test } from "bun:test"
import { appendFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeCodexCli, type CodexExecEvent } from "../../src/kernel/codex-session"

type UnitState = "active" | "inactive" | "absent"

const manager = (behavior?: { readonly ignoreStop?: boolean }) => {
  const commands: ReadonlyArray<string>[] = []
  let state: UnitState = "absent"
  let invocationId = "invocation-1"
  let description = ""
  const runCommand = async (command: ReadonlyArray<string>) => {
    commands.push(command)
    if (command[0] === "systemd-run") {
      state = "active"
      description = command.find((part) => part.startsWith("--description="))?.slice(14) ?? ""
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (command.includes("show-environment")) return { exitCode: 0, stdout: "", stderr: "" }
    if (command.includes("show")) {
      if (state === "absent") return { exitCode: 1, stdout: "", stderr: "Unit not found" }
      return {
        exitCode: 0,
        stdout:
          `InvocationID=${invocationId}\nDescription=${description}\n` +
          `ActiveState=${state}\nSubState=${state === "active" ? "running" : "dead"}\n` +
          `Result=${state === "active" ? "success" : "signal"}\n`,
        stderr: "",
      }
    }
    if (command.includes("stop")) {
      if (!behavior?.ignoreStop) state = "inactive"
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (command.includes("kill")) {
      state = "inactive"
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" }
  }
  return {
    commands,
    runCommand,
    setState: (next: UnitState) => (state = next),
    reuse: () => {
      invocationId = "invocation-reused"
      description = "unrelated service"
      state = "active"
    },
  }
}

const spawn = async (root: string, systemd = manager(), observationTimeoutMs = 100) => {
  const cli = makeCodexCli({
    binary: "codex",
    custodyRoot: root,
    pollIntervalMs: 2,
    observationTimeoutMs,
    cancellationGraceMs: 5,
    runCommand: systemd.runCommand,
  })
  const process = await Effect.runPromise(
    cli.spawn({ runId: "agent-run-systemd", directory: root, prompt: "go", model: null }),
  )
  return { cli, process, systemd, directory: join(root, "agent-run-systemd") }
}

test("persists a pre-launch nonce and the manager InvocationID", async () => {
  const root = join(tmpdir(), `codex-systemd-${crypto.randomUUID()}`)
  try {
    const { directory, process } = await spawn(root)
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
    expect(manifest).toMatchObject({
      version: 2,
      invocationId: "invocation-1",
      executionId: process.executionId,
    })
    expect(manifest.launchId).toMatch(/^[0-9a-f-]{36}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("incremental reader waits for a newline before decoding a partial event", async () => {
  const root = join(tmpdir(), `codex-partial-${crypto.randomUUID()}`)
  try {
    const { directory, process } = await spawn(root)
    const iterator = process.events[Symbol.asyncIterator]()
    await appendFile(join(directory, "events.jsonl"), '{"type":"thread.st')
    const pending = iterator.next()
    expect(
      await Promise.race([pending.then(() => "event"), Bun.sleep(15).then(() => "waiting")]),
    ).toBe("waiting")
    await appendFile(join(directory, "events.jsonl"), 'arted","thread_id":"thread-1"}\n')
    expect(await pending).toEqual({
      done: false,
      value: { type: "thread.started", threadId: "thread-1" } satisfies CodexExecEvent,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("absent and exited units without a result terminate observation clearly", async () => {
  for (const unitState of ["absent", "inactive"] as const) {
    const root = join(tmpdir(), `codex-terminal-${crypto.randomUUID()}`)
    try {
      const launched = await spawn(root)
      launched.systemd.setState(unitState)
      const attached = await Effect.runPromise(launched.cli.attach({ runId: "agent-run-systemd" }))
      expect(attached).not.toBeNull()
      if (attached === null) throw new Error("missing custody")
      const exit = await Effect.runPromise(attached.exited)
      expect(exit.exitCode).toBe(-1)
      expect(exit.stderr).toContain(unitState === "absent" ? "absent" : "without a result")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("active observation has a bounded terminal timeout", async () => {
  const root = join(tmpdir(), `codex-timeout-${crypto.randomUUID()}`)
  try {
    const systemd = manager()
    const { process } = await spawn(root, systemd, 15)
    expect(await Effect.runPromise(process.exited)).toMatchObject({
      exitCode: -1,
      stderr: expect.stringContaining("observation timed out"),
    })
    expect(systemd.commands.some((command) => command.includes("stop"))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unit-name reuse is never attached or signalled", async () => {
  const root = join(tmpdir(), `codex-reuse-${crypto.randomUUID()}`)
  try {
    const launched = await spawn(root)
    launched.systemd.reuse()
    const attached = await Effect.runPromise(
      launched.cli.attach({ runId: "agent-run-systemd" }).pipe(Effect.result),
    )
    expect(attached._tag).toBe("Failure")
    if (attached._tag === "Failure") {
      expect(String(attached.failure.cause)).toContain("invocation identity mismatch")
    }
    const cancelled = await Effect.runPromise(launched.process.cancel.pipe(Effect.result))
    expect(cancelled._tag).toBe("Failure")
    if (cancelled._tag === "Failure") {
      expect(String(cancelled.failure.cause)).toContain("invocation identity mismatch")
    }
    expect(launched.systemd.commands.filter((command) => command.includes("stop"))).toHaveLength(0)
    expect(launched.systemd.commands.filter((command) => command.includes("kill"))).toHaveLength(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("malformed custody fails closed", async () => {
  const root = join(tmpdir(), `codex-malformed-${crypto.randomUUID()}`)
  try {
    const directory = join(root, "agent-run-systemd")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "manifest.json"), '{"version":2,"runId":false}\n')
    const cli = makeCodexCli({
      binary: "codex",
      custodyRoot: root,
      runCommand: manager().runCommand,
    })
    await expect(Effect.runPromise(cli.attach({ runId: "agent-run-systemd" }))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation stops the whole exact unit and escalates before recording cancellation", async () => {
  const root = join(tmpdir(), `codex-cancel-${crypto.randomUUID()}`)
  try {
    const systemd = manager({ ignoreStop: true })
    const { directory, process } = await spawn(root, systemd)
    await Effect.runPromise(process.cancel)
    expect(systemd.commands.some((command) => command.includes("stop"))).toBe(true)
    expect(
      systemd.commands.some(
        (command) => command.includes("kill") && command.includes("--signal=SIGKILL"),
      ),
    ).toBe(true)
    expect(JSON.parse(await readFile(join(directory, "cancelled.json"), "utf8"))).toEqual({
      version: 1,
      invocationId: "invocation-1",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("startup cleanup removes only expired finished custody outside active run protection", async () => {
  const root = join(tmpdir(), `codex-cleanup-${crypto.randomUUID()}`)
  const now = new Date("2026-09-29T00:00:00Z")
  try {
    for (const name of ["agent-run-expired", "agent-run-fresh", "agent-run-protected"]) {
      const directory = join(root, name)
      await mkdir(directory, { recursive: true })
      const result = join(directory, "result.json")
      await writeFile(result, '{"version":1,"exitCode":0}\n')
      const age = name === "agent-run-fresh" ? 500 : 2_000
      await utimes(result, new Date(now.getTime() - age), new Date(now.getTime() - age))
    }
    const cli = makeCodexCli({
      binary: "codex",
      custodyRoot: root,
      retentionMs: 1_000,
      now: () => now,
      runCommand: manager().runCommand,
    })
    expect(await Effect.runPromise(cli.cleanup!(["agent-run-protected"]))).toBe(1)
    await expect(stat(join(root, "agent-run-expired"))).rejects.toThrow()
    expect((await stat(join(root, "agent-run-fresh"))).isDirectory()).toBe(true)
    expect((await stat(join(root, "agent-run-protected"))).isDirectory()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("isolated callers can namespace transient units without changing the default", async () => {
  const root = join(tmpdir(), `codex-prefix-${crypto.randomUUID()}`)
  try {
    const systemd = manager()
    const cli = makeCodexCli({
      binary: "codex",
      custodyRoot: root,
      unitPrefix: "workflowd-evidence59-",
      runCommand: systemd.runCommand,
    })
    const process = await Effect.runPromise(
      cli.spawn({
        runId: "agent-run-prefix",
        directory: root,
        prompt: "go",
        model: null,
      }),
    )
    expect(process.executionId).toMatch(/^workflowd-evidence59-[a-f0-9]{24}\.service$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
