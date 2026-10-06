import { expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runCodexWorker } from "../../src/kernel/codex-worker"
import { runClaudeWorker } from "../../src/kernel/claude-worker"
import { bindingDirectory, sandboxPolicyHash, writeSandboxBinding } from "../../src/sandbox/binding"

for (const kind of ["codex", "claude"] as const) {
  test(`${kind} worker attaches only the owned bridge without bypassing permissions`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workflowd-native-"))
    const directory = join(root, "workspace")
    await mkdir(directory)
    const binding = {
      runId: "agent-run-native-fixture",
      leaseId: "agent-run-native-fixture",
      sessionId: "ses_fixture",
      executorId: `${kind}:local`,
      endpointIdentity: `${kind}://local`,
      directory,
      locationIdentity: directory,
      bridgeServerName: "wfdlease_fixture",
      repositoryId: 1,
      sourceSha: "a".repeat(40),
      policyHash: sandboxPolicyHash,
      transportHash: "b".repeat(64),
      deadline: Date.now() + 60000,
      state: "active" as const,
    }
    await writeSandboxBinding(binding, true)
    const binary = join(root, "capture")
    await writeFile(
      binary,
      `#!${process.execPath}\nif (process.argv.includes("list")) console.log(JSON.stringify([{name:"inherited",enabled:true}])); else console.log(JSON.stringify(process.argv.slice(2)))\n`,
      { mode: 0o755 },
    )
    await writeFile(join(root, "prompt"), "fixture")
    try {
      const options = {
        binary,
        directory,
        promptFile: join(root, "prompt"),
        resultFile: join(root, "result"),
        eventsFile: join(root, "events"),
        stderrFile: join(root, "stderr"),
        maxOutputBytes: 100000,
        model: "dispatch-selected-fixture",
        sandboxBindingFile: join(bindingDirectory(directory), "binding.json"),
      }
      expect(await (kind === "codex" ? runCodexWorker : runClaudeWorker)(options)).toBe(0)
      const args = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
        JSON.parse(await readFile(options.eventsFile, "utf8")),
      )
      expect(args).toContain("dispatch-selected-fixture")
      expect(args.join(" ")).toContain("wfdlease_fixture")
      expect(args.join(" ")).not.toContain("dangerously")
      await writeSandboxBinding({ ...binding, state: "revoked" })
      await expect((kind === "codex" ? runCodexWorker : runClaudeWorker)(options)).rejects.toThrow(
        "inactive",
      )
      if (kind === "codex") {
        expect(args).toContain("--strict-config")
        expect(args).toContain("mcp_servers.inherited.enabled=false")
        expect(args.join(" ")).toContain('default_tools_approval_mode="approve"')
      } else {
        expect(args).toContain("--strict-mcp-config")
        expect(args[args.indexOf("--tools") + 1]).toBe("")
        expect(args).toContain("mcp__wfdlease_fixture__*")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const kind of ["codex", "claude"] as const) {
  test(`installed ${kind} calls container-use through the bound SSH bridge`, async () => {
    const { runnerFixture } = await import("./harness")
    const { nativeModelFixture } = await import("./native-fixture")
    const { compileSandboxBridge } = await import("../../src/sandbox/bridge")
    const { transportHash } = await import("../../src/sandbox/binding")
    const runner = await runnerFixture()
    const fixture = await nativeModelFixture(kind, runner.root)
    const directory = join(runner.root, `${kind}-workspace`)
    await mkdir(directory)
    const binding = {
      runId: runner.name,
      leaseId: runner.transport.leaseId,
      sessionId: "ses_fixture",
      executorId: `${kind}:local`,
      endpointIdentity: `${kind}://local`,
      directory,
      locationIdentity: directory,
      bridgeServerName: "wfdlease_fixture",
      repositoryId: 1,
      sourceSha: "a".repeat(40),
      policyHash: sandboxPolicyHash,
      transportHash: transportHash(runner.transport),
      deadline: Date.now() + 600000,
      state: "active" as const,
    }
    await writeSandboxBinding(binding, true)
    const root = bindingDirectory(directory)
    await compileSandboxBridge(join(root, "bridge"))
    await writeFile(join(root, "transport.json"), JSON.stringify(runner.transport))
    const options = {
      binary: fixture.binary,
      directory,
      promptFile: join(root, "prompt"),
      resultFile: join(root, "result"),
      eventsFile: join(root, "events"),
      stderrFile: join(root, "stderr"),
      maxOutputBytes: 1000000,
      model: "dispatch-selected-fixture",
      sandboxBindingFile: join(root, "binding.json"),
    }
    await writeFile(options.promptFile, "Call the provided environment_list tool once then finish.")
    fixture.actions.push({
      name: "environment_list",
      arguments: { environment_source: "/workspace/repository" },
    })
    fixture.actions.push({
      name: kind === "codex" ? "exec_command" : "Bash",
      arguments: {
        command: `printf escaped > ${join(directory, "native-canary")}`,
        cmd: `printf escaped > ${join(directory, "native-canary")}`,
      },
    })
    try {
      const status = await (kind === "codex" ? runCodexWorker : runClaudeWorker)(options)
      const stderr = await readFile(options.stderrFile, "utf8")
      const events = await readFile(options.eventsFile, "utf8")
      expect({ status, stderr, events }).toMatchObject({ status: 0 })
      expect(events).toContain("native-fixture-complete")
      const frames = events
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              type: Schema.String,
              item: Schema.optionalKey(
                Schema.Struct({
                  type: Schema.String,
                  tool: Schema.optionalKey(Schema.String),
                  status: Schema.optionalKey(Schema.String),
                  error: Schema.optionalKey(Schema.Unknown),
                }),
              ),
              message: Schema.optionalKey(
                Schema.Struct({
                  content: Schema.Array(
                    Schema.Struct({
                      type: Schema.String,
                      is_error: Schema.optionalKey(Schema.Boolean),
                    }),
                  ),
                }),
              ),
            }),
          )(JSON.parse(line)),
        )
      if (kind === "codex")
        expect(
          frames.some(
            (frame) =>
              frame.type === "item.completed" &&
              frame.item?.type === "mcp_tool_call" &&
              frame.item.tool === "environment_list" &&
              frame.item.status === "completed" &&
              frame.item.error === null,
          ),
        ).toBe(true)
      else
        expect(
          frames.some(
            (frame) =>
              frame.type === "user" &&
              frame.message?.content?.some(
                (item: { type: string; is_error?: boolean }) =>
                  item.type === "tool_result" && !item.is_error,
              ),
          ),
        ).toBe(true)
      expect(fixture.requests.length).toBeGreaterThan(2)
      expect(await Bun.file(join(directory, "native-canary")).exists()).toBe(false)
      expect(JSON.stringify(fixture.requests.at(-1))).toContain("environment")
      expect(fixture.catalogs.flat().some((name) => name.endsWith("environment_list"))).toBe(true)
      if (kind === "claude")
        expect(
          fixture.catalogs.flat().every((name) => name.startsWith("mcp__wfdlease_fixture__")),
        ).toBe(true)
      expect(fixture.catalogs.flat()).not.toContain("exec_command")
      expect(fixture.catalogs.flat()).not.toContain("Bash")
      console.log(`${kind} advertised tools: ${JSON.stringify(fixture.catalogs[0])}`)
    } finally {
      await fixture.close()
      await runner.close()
    }
  }, 300000)
}
