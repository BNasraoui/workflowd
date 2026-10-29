import { expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseClaudeDispatchEvent } from "../../src/kernel/claude-dispatch"
import { runClaudeWorker, runClaudeWorkerMain } from "../../src/kernel/claude-worker"

test("Claude stream recognizes session identity, actual model output, usage, and errors", () => {
  const parse = (value: unknown) => parseClaudeDispatchEvent(JSON.stringify(value))
  expect(parse({ type: "system", subtype: "init", session_id: "claude-session" })).toEqual({
    type: "thread.started",
    threadId: "claude-session",
  })
  expect(
    parse({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
    }),
  ).toEqual({ type: "agent_message", text: "OK" })
  expect(
    parse({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    }),
  ).toEqual({ type: "agent_message", text: "[tool_use:Bash]" })
  expect(parse({ type: "result", is_error: false, usage: { output_tokens: 4 } })).toEqual({
    type: "turn.completed",
    outputTokens: 4,
  })
  expect(parse({ type: "result", is_error: true, errors: ["Unknown model"] })).toEqual({
    type: "turn.failed",
    message: "Unknown model",
  })
  expect(
    parse({
      type: "assistant",
      error: "authentication_failed",
      message: { content: [{ type: "text", text: "Please login" }] },
    }),
  ).toEqual({ type: "error", message: "authentication_failed: Please login" })
  expect(parseClaudeDispatchEvent("bad json")).toEqual({ type: "other" })
})

test("durable worker invokes Claude print mode directly and persists output and exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-claude-worker-"))
  try {
    const binary = join(root, "fake-claude")
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nconst text = await Bun.stdin.text();\nconsole.log(JSON.stringify({ type: "system", subtype: "init", session_id: "test-session" }));\nconsole.log(JSON.stringify({ type: "assistant", message: { content: [{type: "text", text: "OK"}] } }));\nconsole.log(JSON.stringify({ type: "result", is_error: false, usage: {output_tokens: 4} }));\nawait Bun.write(${JSON.stringify(join(root, "invocation.json"))}, JSON.stringify({args: process.argv.slice(2), prompt: text, cwd: process.cwd()}));\n`,
      { mode: 0o700 },
    )
    const promptFile = join(root, "prompt")
    await writeFile(promptFile, "Reply OK")
    const resultFile = join(root, "result.json")
    const eventsFile = join(root, "events.jsonl")
    expect(
      await runClaudeWorker({
        binary,
        directory: root,
        promptFile,
        resultFile,
        eventsFile,
        stderrFile: join(root, "stderr"),
        maxOutputBytes: 10000,
        model: "claude-opus-5-5",
        effort: "xhigh",
      }),
    ).toBe(0)
    const invoked = JSON.parse(await readFile(join(root, "invocation.json"), "utf8"))
    expect(invoked.args).toEqual([
      "--print",
      "--settings",
      '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}',
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--setting-sources",
      "user",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--model",
      "claude-opus-5-5",
      "--effort",
      "xhigh",
    ])
    expect(invoked.prompt).toBe("Reply OK")
    expect(invoked.cwd).toBe(root)
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({ version: 1, exitCode: 0 })
    expect(
      (await readFile(eventsFile, "utf8")).trim().split("\n").map(parseClaudeDispatchEvent),
    ).toEqual([
      { type: "thread.started", threadId: "test-session" },
      { type: "agent_message", text: "OK" },
      { type: "turn.completed", outputTokens: 4 },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Claude worker entrypoint reports malformed launches without starting a model", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(await runClaudeWorkerMain(["--binary", "/usr/bin/true"])).toBe(1)
    expect(errors).toHaveBeenCalledWith("missing --directory")
  } finally {
    errors.mockRestore()
  }
})

for (const status of [0, 7]) {
  test(`Claude worker entrypoint persists native exit ${status}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-entrypoint-"))
    try {
      const binary = join(root, "claude")
      await writeFile(binary, `#!/bin/sh\ncat\necho diagnostic >&2\nexit ${status}\n`, {
        mode: 0o700,
      })
      await writeFile(join(root, "prompt"), "fixture prompt")
      const args = [
        "--binary",
        binary,
        "--directory",
        root,
        "--prompt-file",
        join(root, "prompt"),
        "--events-file",
        join(root, "events"),
        "--stderr-file",
        join(root, "stderr"),
        "--result-file",
        join(root, "result"),
        "--max-output-bytes",
        "1024",
      ]
      expect(await runClaudeWorkerMain(args)).toBe(status)
      expect(JSON.parse(await readFile(join(root, "result"), "utf8"))).toEqual({
        version: 1,
        exitCode: status,
      })
      expect(await readFile(join(root, "events"), "utf8")).toBe("fixture prompt")
      expect(await readFile(join(root, "stderr"), "utf8")).toBe("diagnostic\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("rapid native exits persist every result after draining both output streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-rapid-exit-"))
  try {
    const binary = join(root, "claude")
    await writeFile(binary, "#!/bin/sh\ncat\necho diagnostic >&2\n", { mode: 0o700 })
    const promptFile = join(root, "prompt")
    await writeFile(promptFile, "fixture prompt")
    for (let attempt = 0; attempt < 300; attempt++) {
      const options = {
        binary,
        directory: root,
        promptFile,
        eventsFile: join(root, "events"),
        stderrFile: join(root, "stderr"),
        resultFile: join(root, "result"),
        maxOutputBytes: 1024,
        model: null,
      }
      expect(await runClaudeWorker(options)).toBe(0)
      expect(JSON.parse(await readFile(options.resultFile, "utf8"))).toEqual({
        version: 1,
        exitCode: 0,
      })
      expect(await readFile(options.eventsFile, "utf8")).toBe("fixture prompt")
      expect(await readFile(options.stderrFile, "utf8")).toBe("diagnostic\n")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
