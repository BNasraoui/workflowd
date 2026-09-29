import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeCodexCli, type CodexExecEvent } from "../../src/kernel/codex-session"
import { parseCodexWorkerArguments, runCodexWorker } from "../../src/kernel/codex-worker"

test("the worker command parser accepts exact pairs and rejects malformed arguments", () => {
  expect(
    parseCodexWorkerArguments([
      "--binary",
      "codex",
      "--directory",
      "/work",
      "--prompt-file",
      "/state/prompt",
      "--result-file",
      "/state/result",
      "--events-file",
      "/state/events",
      "--stderr-file",
      "/state/stderr",
      "--max-output-bytes",
      "1024",
      "--model",
      "gpt-5.1-codex",
    ]),
  ).toEqual({
    binary: "codex",
    directory: "/work",
    promptFile: "/state/prompt",
    resultFile: "/state/result",
    eventsFile: "/state/events",
    stderrFile: "/state/stderr",
    maxOutputBytes: 1024,
    model: "gpt-5.1-codex",
  })
  expect(() => parseCodexWorkerArguments(["binary", "codex"])).toThrow("--name value pairs")
  expect(() => parseCodexWorkerArguments(["--binary", "codex"])).toThrow("missing --directory")
})

test("the transient worker feeds the prompt on stdin and records its exit durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-worker-"))
  try {
    const promptPath = join(root, "prompt")
    const resultPath = join(root, "result.json")
    const capturePath = join(root, "stdin-capture")
    const eventsPath = join(root, "events.jsonl")
    const stderrPath = join(root, "stderr.log")
    const binary = join(root, "codex")
    await writeFile(promptPath, "prompt stays out of argv")
    await writeFile(binary, `#!/bin/sh\ncat > "${capturePath}"\nexit 7\n`, { mode: 0o755 })

    const exitCode = await runCodexWorker({
      binary,
      directory: root,
      promptFile: promptPath,
      resultFile: resultPath,
      eventsFile: eventsPath,
      stderrFile: stderrPath,
      maxOutputBytes: 64,
      model: null,
    })

    expect(exitCode).toBe(7)
    expect(await readFile(capturePath, "utf8")).toBe("prompt stays out of argv")
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ version: 1, exitCode: 7 })
    expect((await stat(eventsPath)).size).toBeLessThanOrEqual(64)
    expect((await stat(stderrPath)).size).toBeLessThanOrEqual(64)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("launches in an independent user service with durable custody and no prompt in argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-custody-"))
  const commands: ReadonlyArray<string>[] = []
  try {
    const cli = makeCodexCli({
      binary: "/opt/codex/bin/codex",
      custodyRoot: root,
      runCommand: async (command) => {
        commands.push(command)
        return { exitCode: 0, stderr: "" }
      },
    })
    const run = await Effect.runPromise(
      cli.spawn({
        runId: "agent-run-abc123",
        directory: "/work/agent-run",
        prompt: "credential rotation must not kill me",
        model: "gpt-5.1-codex",
      }),
    )

    expect(commands).toHaveLength(1)
    expect(commands[0]![0]).toBe("systemd-run")
    expect(commands[0]).toContain("--user")
    expect(commands[0]).toContain("--service-type=exec")
    expect(commands[0]).toContain(`--unit=${run.executionId}`)
    expect(commands[0]).toContain("--max-output-bytes")
    expect(commands[0]).toContain(String(10 * 1024 * 1024))
    expect(commands[0]!.join(" ")).not.toContain("credential rotation must not kill me")
    expect(
      JSON.parse(await readFile(join(root, "agent-run-abc123", "manifest.json"), "utf8")),
    ).toMatchObject({
      version: 1,
      runId: "agent-run-abc123",
      executionId: run.executionId,
    })
    expect(await readFile(join(root, "agent-run-abc123", "prompt"), "utf8")).toBe(
      "credential rotation must not kill me",
    )
    expect((await stat(join(root, "agent-run-abc123", "prompt"))).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reattaches to durable output without relaunching and cancels only when explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-custody-"))
  const commands: ReadonlyArray<string>[] = []
  try {
    const options = {
      binary: "/opt/codex/bin/codex",
      custodyRoot: root,
      pollIntervalMs: 5,
      runCommand: async (command: ReadonlyArray<string>) => {
        commands.push(command)
        return { exitCode: 0, stderr: "" }
      },
    }
    const launched = await Effect.runPromise(
      makeCodexCli(options).spawn({
        runId: "agent-run-restart",
        directory: "/work/restart",
        prompt: "finish after restart",
        model: null,
      }),
    )
    const custody = join(root, "agent-run-restart")
    await writeFile(
      join(custody, "events.jsonl"),
      '{"type":"thread.started","thread_id":"thread-restart"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
    )
    await writeFile(join(custody, "result.json"), '{"version":1,"exitCode":0}\n')

    const reattached = await Effect.runPromise(
      makeCodexCli(options).attach({ runId: "agent-run-restart" }),
    )
    expect(reattached).not.toBeNull()
    if (reattached === null) throw new Error("expected durable custody")
    const events: CodexExecEvent[] = []
    for await (const event of reattached.events) events.push(event)
    expect(await Effect.runPromise(reattached.exited)).toEqual({ exitCode: 0, stderr: "" })
    expect(events.some((event) => event.type === "agent_message")).toBe(true)
    expect(reattached.executionId).toBe(launched.executionId)
    expect(commands).toHaveLength(1)

    const pending = await Effect.runPromise(
      makeCodexCli(options).spawn({
        runId: "agent-run-cancel",
        directory: "/work/cancel",
        prompt: "cancel explicitly",
        model: null,
      }),
    )
    await Effect.runPromise(pending.cancel)
    expect(commands.find((command) => command[0] === "systemctl")).toContain(pending.executionId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
