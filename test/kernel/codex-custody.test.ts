import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeCodexCli, type CodexExecEvent } from "../../src/kernel/codex-session"
import {
  parseCodexWorkerArguments,
  runCodexWorker,
  runHostWorker,
} from "../../src/kernel/codex-worker"

const fakeSystemd = (commands: ReadonlyArray<string>[]) => {
  let active = false
  let description = ""
  return async (command: ReadonlyArray<string>) => {
    commands.push(command)
    if (command[0] === "systemd-run") {
      active = true
      description = command.find((part) => part.startsWith("--description="))?.slice(14) ?? ""
    } else if (command.includes("stop") || command.includes("kill")) {
      active = false
    }
    if (command.includes("show")) {
      return {
        exitCode: 0,
        stdout:
          `InvocationID=invocation-test\nDescription=${description}\n` +
          `ActiveState=${active ? "active" : "inactive"}\nResult=success\n`,
        stderr: "",
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

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
      runCommand: fakeSystemd(commands),
    })
    const run = await Effect.runPromise(
      cli.spawn({
        runId: "agent-run-abc123",
        directory: "/work/agent-run",
        prompt: "credential rotation must not kill me",
        model: "gpt-5.1-codex",
      }),
    )

    const launch = commands.find((command) => command[0] === "systemd-run")!
    expect(launch).toContain("--user")
    expect(launch).toContain("--service-type=exec")
    expect(launch).toContain(`--unit=${run.executionId}`)
    expect(launch).toContain("--max-output-bytes")
    expect(launch).toContain(String(10 * 1024 * 1024))
    expect(launch.join(" ")).not.toContain("credential rotation must not kill me")
    expect(
      JSON.parse(await readFile(join(root, "agent-run-abc123", "manifest.json"), "utf8")),
    ).toMatchObject({
      version: 2,
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
      runCommand: fakeSystemd(commands),
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
    expect(commands.filter((command) => command[0] === "systemd-run")).toHaveLength(1)

    const pending = await Effect.runPromise(
      makeCodexCli(options).spawn({
        runId: "agent-run-cancel",
        directory: "/work/cancel",
        prompt: "cancel explicitly",
        model: null,
      }),
    )
    await Effect.runPromise(pending.cancel)
    expect(
      commands.find(
        (command) => command[0] === "systemctl" && command.includes(pending.executionId),
      ),
    ).toBeDefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("host worker profiles preserve stdin and keep native result files bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-worker-profiles-"))
  try {
    const binary = join(root, "native")
    const capture = join(root, "capture")
    await writeFile(
      binary,
      `#!/bin/sh\ncase "$1" in --version) echo version;; login) exit 0;; auth) echo '{"loggedIn":true}';; *) cat > '${capture}'; echo '{"result":"native output"}';; esac\n`,
      { mode: 0o755 },
    )
    for (const profile of [
      "codex",
      "claude",
      "claude-resume",
      "codex-preflight",
      "claude-preflight",
      "claude-session",
      "codex-server",
    ] as const) {
      const input = join(root, "input")
      await writeFile(
        input,
        JSON.stringify({
          operation: "start",
          profile,
          runId: "worker-fixture",
          directory: root,
          nativeSessionId: "missing-fixture-session",
          model: "fixture",
          effort: "high",
          provider: "fixture",
          prompt: "secret stays on stdin",
        }),
      )
      expect(await runHostWorker(input, binary)).toBe(0)
      expect(JSON.parse(await readFile(join(root, "result"), "utf8"))).toEqual({
        version: 1,
        exitCode: 0,
      })
      if (["codex", "claude", "claude-resume", "codex-server"].includes(profile)) {
        expect(await readFile(capture, "utf8")).toBe("secret stays on stdin")
        expect(await readFile(join(root, "events"), "utf8")).toContain("native output")
      }
      if (profile === "claude-session")
        expect(await readFile(join(root, "events"), "utf8")).toBe("false")
    }
    await writeFile(
      binary,
      `#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\necho '{"loggedIn":false}'\n`,
      { mode: 0o755 },
    )
    await writeFile(
      join(root, "input"),
      JSON.stringify({
        operation: "start",
        profile: "claude-preflight",
        runId: "bad-auth",
        directory: root,
        model: null,
        prompt: "",
      }),
    )
    await expect(runHostWorker(join(root, "input"), binary)).rejects.toThrow(
      "native authentication unavailable",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("host discovery worker exchanges the native model catalog and workspace worker creates a separate clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-worker-workspace-"))
  try {
    const input = join(root, "input")
    const binary = join(root, "discovery")
    await writeFile(
      binary,
      `#!${process.execPath}\nawait import(${JSON.stringify(join(import.meta.dir, "../execution/fixtures/codex-app-server.mjs"))})\n`,
      { mode: 0o755 },
    )
    await writeFile(
      input,
      JSON.stringify({
        operation: "start",
        profile: "codex-discovery",
        runId: "discovery-worker",
        directory: root,
        prompt: "",
        model: null,
      }),
    )
    expect(await runHostWorker(input, binary)).toBe(0)
    const models = JSON.parse(await readFile(join(root, "events"), "utf8"))
    expect(models).toMatchObject([{ model: "first" }, { model: "second" }])
    const source = join(root, "source")
    const git = async (args: string[]) => {
      const child = Bun.spawn(["git", ...args], {
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      if ((await child.exited) !== 0) throw new Error(stderr)
    }
    await git(["init", "--initial-branch=main", source])
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ])
    const directory = join(root, "clone")
    const request = {
      operation: "start",
      profile: "workspace",
      runId: "workspace-worker",
      directory,
      repository: source,
      branch: "agent-run",
      prompt: "",
      model: null,
    }
    await writeFile(input, JSON.stringify(request))
    expect(await runHostWorker(input, binary)).toBe(0)
    expect((await stat(join(directory, ".git"))).isDirectory()).toBe(true)
    expect(await readFile(join(directory, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/agent-run\n",
    )
    expect(
      await readFile(join(directory, ".git", "objects", "info", "alternates"), "utf8").catch(
        () => null,
      ),
    ).toBeNull()
    await writeFile(input, JSON.stringify({ ...request, branch: "--invalid" }))
    await expect(runHostWorker(input, binary)).rejects.toThrow("invalid workspace selection")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the deployed worker entrypoint completes a Claude launch without a circular module wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-entrypoint-"))
  try {
    const binary = join(root, "claude")
    await writeFile(binary, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"result"}\'\n', {
      mode: 0o755,
    })
    const input = join(root, "input")
    await writeFile(
      input,
      JSON.stringify({
        operation: "start",
        profile: "claude",
        runId: "entrypoint",
        directory: root,
        prompt: "fixture",
        model: null,
      }),
    )
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../src/kernel/codex-worker.ts")],
      target: "bun",
    })
    expect(build.success).toBe(true)
    const worker = join(root, "worker.js")
    await writeFile(worker, await build.outputs[0]!.text())
    const child = Bun.spawn([process.execPath, worker, "--host-input", input, "--binary", binary], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500)
    try {
      expect(await child.exited).toBe(0)
      expect(JSON.parse(await readFile(join(root, "result"), "utf8"))).toEqual({
        version: 1,
        exitCode: 0,
      })
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
