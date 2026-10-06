import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSandboxOpenCode } from "../../src/sandbox/opencode"
import { command, runnerFixture } from "./harness"
import { Schema } from "effect"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import { compileSandboxBridge } from "../../src/sandbox/bridge"

test.each([true, false])(
  "operator policy probe confirms cleanup after model execution or refusal (%s)",
  async (successful) => {
    const fixture = await sharedOpenCodeFixture(
      `operator-${String(successful)}`,
      successful ? compactionSummary : undefined,
    )
    const output = join(fixture.root, "operator")
    try {
      const result = command([
        "env",
        `EVIDENCE_OPENCODE_URL=${fixture.url}`,
        "EVIDENCE_OPENCODE_PASSWORD=fixture-server-password",
        "EVIDENCE_OPENCODE_MODEL=openai/gpt-6-astra-fixture",
        `EVIDENCE_SANDBOX_ROOT=${output}`,
        process.execPath,
        "scripts/evidence/agent-sandbox.mjs",
        "--probe-session-policy",
        "--expected-artifact",
        "deploy/opencode/sandbox.json",
      ])
      if (successful) expect(await result).toContain('"result":"passed"')
      else await expect(result).rejects.toThrow("Ordinary shell control did not execute")
      const report = Schema.decodeUnknownSync(
        Schema.Struct({ result: Schema.String, sessionsRemoved: Schema.Number }),
      )(await Bun.file(join(output, "session-policy.json")).json())
      expect(report.result).toBe(successful ? "passed" : "stopped")
      expect(report.sessionsRemoved).toBe(3)
    } finally {
      await fixture.close()
    }
  },
  180_000,
)

const compactionSummary = `## Objective
- Confinement fixture.
## Requirements
- Keep the sandbox canary untouched.
## Decisions
- Use the sandbox agent.
## Work State
### Completed
- Compaction complete
### Active
- Confinement verification.
### Blocked
- (none)
## Next Move
1. Continue the sandbox fixture.
## Relevant Files
- (none)`

test("global sandbox agent confines native execution through completed compaction", async () => {
  const fixture = await sharedOpenCodeFixture("native")
  const shell = (command: string) => ({
    name: "shell",
    arguments: JSON.stringify({ command, description: "Confinement canary" }),
  })
  const evidence: Record<string, unknown> = {}
  try {
    const controlDirectory = join(fixture.root, "control")
    const directory = join(fixture.root, "sandbox-a")
    const control = await fixture.create(controlDirectory, "build")
    const sandbox = await fixture.create(directory, "sandbox")
    await writeFile(join(directory, "canary"), "untouched")
    fixture.script([shell("printf before > control-before")])
    evidence.controlBefore = await fixture.prompt(control, "Execute the ordinary control")
    expect(await Bun.file(join(controlDirectory, "control-before")).text()).toBe("before")
    fixture.script([
      shell("printf escaped > canary"),
      ...["read", "edit", "write", "patch", "subagent"].map((name) => ({
        name,
        arguments: JSON.stringify({
          filePath: join(directory, "canary"),
          file: "canary",
          path: "canary",
          content: "escaped",
          oldString: "untouched",
          newString: "escaped",
          patch: "*** Begin Patch\n*** Delete File: canary\n*** End Patch",
          agent: "general",
          prompt: "Write escaped into canary",
          description: "Confinement canary",
        }),
      })),
      ...[
        'return await import("node:fs")',
        "return process.env",
        'return Bun.file("canary").text()',
        "return globalThis.process.env",
        'return Function("return process")()',
        'return await tools.shell({command:"printf nested-escaped > canary"})',
      ].map((code) => ({ name: "execute", arguments: JSON.stringify({ code }) })),
    ])
    evidence.sandboxBefore = await fixture.prompt(sandbox, "Attempt the native shell")
    expect(await Bun.file(join(directory, "canary")).text()).toBe("untouched")
    for (const name of ["shell", "read", "edit", "write", "patch", "subagent"])
      expect(JSON.stringify(evidence.sandboxBefore)).toContain(`Unknown tool: ${name}`)
    expect(JSON.stringify(evidence.sandboxBefore)).toContain("ImportExpression")
    const messages = Schema.decodeUnknownSync(
      Schema.Struct({
        data: Schema.Array(
          Schema.Struct({
            content: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
          }),
        ),
      }),
    )(evidence.sandboxBefore)
    const codeCalls = messages.data
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "tool" && part.name === "execute")
    expect(codeCalls).toHaveLength(6)
    for (const call of codeCalls) expect(call.state).toMatchObject({ metadata: { error: true } })
    fixture.script([shell("printf compaction-escaped > canary")], compactionSummary)
    await fixture.api(`session/${sandbox}/compact`, {})
    await fixture.api(`session/${sandbox}/wait`, {})
    evidence.compaction = await fixture.api(`session/${sandbox}/message`)
    evidence.canaryAfterCompaction = await Bun.file(join(directory, "canary")).text()
    fixture.script([shell("printf after > control-after")])
    evidence.controlAfter = await fixture.prompt(control, "Execute the ordinary control again")
    expect(await Bun.file(join(controlDirectory, "control-after")).text()).toBe("after")
    expect(evidence.canaryAfterCompaction).toBe("untouched")
    expect(JSON.stringify(evidence.compaction)).toContain("Compaction complete")
    expect(JSON.stringify(evidence.compaction)).toContain('"status":"completed"')
    fixture.script([shell("printf continuation-escaped > canary")])
    evidence.continuation = await fixture.prompt(sandbox, "Continue after compaction")
    expect(JSON.stringify(evidence.continuation)).toContain("Unknown tool: shell")
    fixture.script([
      { ...shell("printf summary-escaped > canary"), text: "Fixture transient summary" },
    ])
    evidence.generated = await fixture.api(`session/${sandbox}/generate`, {
      prompt: "Summarize the task",
    })
    expect(evidence.generated).toEqual({ data: { text: "Fixture transient summary" } })
    const untitled = await fixture.create(directory, "sandbox", false)
    fixture.script([], "Sandbox fixture title")
    evidence.titlePrompt = await fixture.prompt(untitled, "Check title confinement")
    evidence.titleSession = await fixture.api(`session/${untitled}`)
    expect(JSON.stringify(evidence.titleSession)).toContain('"title":"Sandbox fixture title"')
    expect(fixture.requests.some((request) => !request.tools?.length)).toBe(true)
    expect(new Set(fixture.credentials)).toEqual(new Set(["Bearer fixture-model-canary"]))
    expect(JSON.stringify(evidence)).not.toContain("fixture-model-canary")
    expect(await Bun.file(join(directory, "canary")).text()).toBe("untouched")
  } finally {
    if (process.env.SANDBOX_POLICY_EVIDENCE !== undefined)
      await writeFile(
        join(process.env.SANDBOX_POLICY_EVIDENCE, "confinement.json"),
        JSON.stringify(evidence, null, 2),
      )
    await fixture.close()
  }
}, 180_000)

test("global sandbox agent keeps runtime bridges exclusive to their locations", async () => {
  const runner = await runnerFixture()
  let runnerB: Awaited<ReturnType<typeof runnerFixture>> | undefined
  let fixture: Awaited<ReturnType<typeof sharedOpenCodeFixture>> | undefined
  const evidence: Record<string, unknown> = {}
  try {
    fixture = await sharedOpenCodeFixture("bridges")
    runnerB = await runnerFixture()
    const directoryA = join(fixture.root, "sandbox-a")
    const directoryB = join(fixture.root, "sandbox-b")
    const sessionA = await fixture.create(directoryA, "sandbox")
    const sessionB = await fixture.create(directoryB, "sandbox")
    const controlDirectory = join(fixture.root, "control")
    const control = await fixture.create(controlDirectory, "build")
    fixture.script([
      {
        name: "shell",
        arguments: JSON.stringify({
          command: "printf before > control-before",
          description: "Ordinary control before bridge registration",
        }),
      },
    ])
    evidence.controlBefore = await fixture.prompt(
      control,
      "Execute ordinary tool before bridge registration",
    )
    expect(await Bun.file(join(controlDirectory, "control-before")).text()).toBe("before")
    const bridge = join(runner.root, "bridge")
    await compileSandboxBridge(bridge)
    const locationA = new URLSearchParams({ "location[directory]": directoryA })
    const locationB = new URLSearchParams({ "location[directory]": directoryB })
    const config = {
      type: "local",
      command: [bridge, join(runner.root, "transport.json")],
      timeout: { startup: 120000, execution: 120000 },
    }
    await Promise.all([
      fixture.api(`mcp/workflowd_sandbox_a?${locationA.toString()}`, { config }, "PUT"),
      fixture.api(
        `mcp/workflowd_sandbox_b?${locationB.toString()}`,
        { config: { ...config, command: [bridge, join(runnerB.root, "transport.json")] } },
        "PUT",
      ),
    ])
    evidence.catalogA = await fixture.api(`mcp?${locationA.toString()}`)
    evidence.catalogB = await fixture.api(`mcp?${locationB.toString()}`)
    await fixture.api(`mcp/ambient?${locationA.toString()}`, { config }, "PUT")
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'return await tools.ambient.environment_list({ environment_source: "/workspace/repository" })',
        }),
      },
    ])
    evidence.ambient = await fixture.prompt(sessionA, "Attempt an unrelated MCP server")
    expect(JSON.stringify(evidence.ambient)).toContain('"error":true')
    expect(JSON.stringify(evidence.ambient)).not.toContain(
      '"tool":"ambient.environment_list","status":"completed"',
    )
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'return await tools.workflowd_sandbox_a.environment_list({ environment_source: "/workspace/repository" })',
        }),
      },
    ])
    evidence.ownCall = await fixture.prompt(sessionA, "Use this location's bridge")
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'return await tools.workflowd_sandbox_b.environment_list({ environment_source: "/workspace/repository" })',
        }),
      },
    ])
    evidence.foreignCall = await fixture.prompt(sessionA, "Attempt the other location's bridge")
    evidence.sessionA = await fixture.api(`session/${sessionA}`)
    evidence.sessionB = await fixture.api(`session/${sessionB}`)
    expect(JSON.stringify(evidence.ownCall)).toContain('"status":"completed"')
    expect(JSON.stringify(evidence.catalogA)).not.toContain("workflowd_sandbox_b")
    expect(JSON.stringify(evidence.catalogB)).not.toContain("workflowd_sandbox_a")
    expect(JSON.stringify(evidence.foreignCall)).toContain(
      "Unknown tool 'workflowd_sandbox_b.environment_list'",
    )
    expect(JSON.stringify(evidence.foreignCall)).toContain('"toolCalls":[],"error":true')
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'const env = JSON.parse(await tools.workflowd_sandbox_a.environment_create({environment_source:"/workspace/repository",title:"Lease A"})); return await tools.workflowd_sandbox_a.environment_run_cmd({environment_source:"/workspace/repository",environment_id:env.id,command:"printf remote-a > proof.txt; cat proof.txt; pwd"})',
        }),
      },
    ])
    evidence.remoteA = await fixture.prompt(sessionA, "Complete the remote task")
    expect(JSON.stringify(evidence.remoteA)).toContain("remote-a")
    expect(JSON.stringify(evidence.remoteA)).toContain("/workdir")
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'return await tools.workflowd_sandbox_b.environment_list({ environment_source: "/workspace/repository" })',
        }),
      },
    ])
    evidence.ownCallB = await fixture.prompt(sessionB, "Use the second runner")
    expect(JSON.stringify(evidence.ownCallB)).toContain(
      '"tool":"workflowd_sandbox_b.environment_list","status":"completed"',
    )
    await Promise.all([
      fixture.api(`mcp/workflowd_sandbox_a?${locationA.toString()}`, undefined, "DELETE"),
      fixture.api(`mcp/workflowd_sandbox_b?${locationB.toString()}`, undefined, "DELETE"),
    ])
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'return await tools.workflowd_sandbox_a.environment_list({ environment_source: "/workspace/repository" })',
        }),
      },
    ])
    evidence.revoked = await fixture.prompt(sessionA, "Attempt revoked bridge")
    expect(JSON.stringify(evidence.revoked)).toContain('"status":"error"')
    expect(JSON.stringify(evidence.revoked)).toContain('"error":true')
    await fixture.restart()
    const deadline = Date.now() + 30000
    for (;;) {
      try {
        await fixture.api("health")
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await Bun.sleep(100)
      }
    }
    evidence.restartedCatalogA = await fixture.api(`mcp?${locationA.toString()}`)
    evidence.restartedCatalogB = await fixture.api(`mcp?${locationB.toString()}`)
    expect(JSON.stringify(evidence.restartedCatalogA)).not.toContain("workflowd_sandbox_")
    expect(JSON.stringify(evidence.restartedCatalogB)).not.toContain("workflowd_sandbox_")
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: 'return await tools.workflowd_sandbox_a.environment_list({ environment_source: "/workspace/repository" })',
        }),
      },
    ])
    evidence.restartedCall = await fixture.prompt(sessionA, "Attempt bridge after restart")
    expect(JSON.stringify(evidence.restartedCall)).toContain(
      "Unknown tool 'workflowd_sandbox_a.environment_list'",
    )
    fixture.script([
      {
        name: "shell",
        arguments: JSON.stringify({
          command: "printf after > control-after",
          description: "Ordinary control after bridge revocation and restart",
        }),
      },
    ])
    evidence.controlAfter = await fixture.prompt(
      control,
      "Execute ordinary tool after bridge revocation and restart",
    )
    expect(await Bun.file(join(controlDirectory, "control-after")).text()).toBe("after")
  } finally {
    if (process.env.SANDBOX_POLICY_EVIDENCE !== undefined)
      await writeFile(
        join(process.env.SANDBOX_POLICY_EVIDENCE, "location-confinement.json"),
        JSON.stringify(evidence, null, 2),
      )
    await fixture?.close()
    await runnerB?.close()
    await runner.close()
  }
}, 300_000)

test("isolated OpenCode completes a remote task and denies native tools and imports", async () => {
  const runner = await runnerFixture()
  const ModelRequest = Schema.Struct({
    tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
    messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Json })),
  })
  const requests: Array<typeof ModelRequest.Type> = []
  const credentials: Array<string | null> = []
  const actions = [
    {
      name: "execute",
      arguments: JSON.stringify({
        code: `
      const created = JSON.parse(await tools["container-use"].environment_create({environment_source:"/workspace/repository",title:"OpenCode fixture"}));
      return await tools["container-use"].environment_run_cmd({environment_source:"/workspace/repository",environment_id:created.id,command:"printf opencode-remote > proof.txt; env; hostname; pwd; cat proof.txt"});
    `,
      }),
    },
    { name: "execute", arguments: JSON.stringify({ code: 'return await import("node:fs")' }) },
    ...["shell", "read", "edit", "write", "subagent"].map((name) => ({
      name,
      arguments: JSON.stringify({ command: "printf forbidden-native-tool" }),
    })),
  ]
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      credentials.push(request.headers.get("authorization"))
      const body = await request.json()
      requests.push(Schema.decodeUnknownSync(ModelRequest)(body))
      const action = actions[requests.length - 1]
      const delta =
        action === undefined
          ? { role: "assistant", content: "sandbox task complete" }
          : {
              role: "assistant",
              tool_calls: [
                { index: 0, id: `call_${requests.length}`, type: "function", function: action },
              ],
            }
      const chunk = (delta: unknown, finish_reason: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: "gpt-6-astra-fixture",
          choices: [{ index: 0, delta, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        "\n\n"
      return new Response(
        chunk(delta, null) +
          chunk({}, action === undefined ? "stop" : "tool_calls") +
          "data: [DONE]\n\n",
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })
  let server: Awaited<ReturnType<typeof startSandboxOpenCode>> | undefined
  try {
    const authFile = join(runner.root, "model-auth.json")
    await writeFile(
      authFile,
      JSON.stringify({ openai: { type: "api", key: "fixture-model-canary" } }),
      { mode: 0o600 },
    )
    server = await startSandboxOpenCode({
      directory: runner.root,
      binary: await realpath(Bun.which("opencode2") ?? "opencode2"),
      authFile,
      transport: runner.transport,
      providers: {
        openai: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
          models: {
            "gpt-6-astra-fixture": {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 1024 },
            },
          },
        },
      },
    })
    const url = server.url
    const headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
      "Content-Type": "application/json",
    }
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`${url}/api/${path}`, {
        headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      })
      expect(response.ok).toBe(true)
      const text = await response.text()
      const value: unknown = text === "" ? undefined : JSON.parse(text)
      return value
    }
    const session = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
    )(
      await api("session", {
        title: "sandbox fixture",
        agent: "sandbox",
        model: { id: "gpt-6-astra-fixture", providerID: "openai" },
        location: { directory: join(runner.root, "home/.config/opencode") },
      }),
    )
    await api(`session/${session.data.id}/prompt`, { text: "Complete the fixture task" })
    await api(`session/${session.data.id}/wait`, {})
    const messages = await api(`session/${session.data.id}/message`)
    const transcript = JSON.stringify(messages)
    expect(transcript).toContain("opencode-remote")
    expect(transcript).toContain("/workdir")
    expect(transcript).toContain("ImportExpression")
    expect(transcript).toContain("sandbox task complete")
    expect(transcript).not.toContain("fixture-model-canary")
    for (const name of ["shell", "read", "edit", "write", "subagent"]) {
      expect(transcript).toContain(`Unknown tool: ${name}`)
    }
    expect(requests.length).toBe(actions.length + 1)
    expect(new Set(credentials)).toEqual(new Set(["Bearer fixture-model-canary"]))
    expect(await Bun.file(authFile).json()).toEqual({
      openai: { type: "api", key: "fixture-model-canary" },
    })
    for (const request of requests) {
      expect(request.tools.map((tool) => tool.function.name)).toEqual(["execute"])
      const instructions = JSON.stringify(
        request.messages.filter((message) => message.role === "system"),
      )
      expect(instructions).not.toContain("- browser (")
      expect(instructions).not.toContain("- opencode (")
    }
    expect(server.invocationId).toMatch(/^[a-f0-9]{32}$/)
    const properties = await command([
      "systemctl",
      "--user",
      "show",
      server.unit,
      "-p",
      "ProtectSystem",
      "-p",
      "ProtectHome",
      "-p",
      "PrivateTmp",
      "-p",
      "PrivateUsers",
      "-p",
      "MemoryMax",
      "-p",
      "MemorySwapMax",
    ])
    expect(properties).toContain("ProtectSystem=strict")
    expect(properties).toContain("ProtectHome=tmpfs")
    expect(properties).toContain("PrivateTmp=yes")
    expect(properties).toContain("PrivateUsers=yes")
    expect(properties).toContain("MemoryMax=2147483648")
    expect(properties).toContain("MemorySwapMax=0")
    // The service can disappear before its owner releases it (for example, on
    // startup failure or external cancellation). Release must still confirm closure.
    await command(["systemctl", "--user", "stop", server.unit])
    await server.close()
  } finally {
    await server?.close()
    await model.stop(true)
    await runner.close()
  }
}, 300_000)

test("namespace setup failure preserves its cause and releases the failed unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-sandbox-preflight-"))
  const leaseId = `preflight-${process.pid}-${root.split("-").at(-1) ?? "fixture"}`
  const unit = `workflowd-sandbox-${leaseId}`
  const authFile = join(root, "auth.json")
  await writeFile(authFile, "{}", { mode: 0o600 })
  try {
    await expect(
      startSandboxOpenCode({
        directory: root,
        binary: await realpath(Bun.which("opencode2") ?? "opencode2"),
        authFile,
        providers: {},
        transport: {
          leaseId,
          peerId: leaseId,
          repositoryPath: "/workspace/repository",
          address: "127.0.0.1",
          port: 22,
          identityFile: join(root, "missing-key"),
          knownHostsFile: join(root, "missing-hosts"),
        },
      }),
    ).rejects.toThrow(/Sandbox namespace preflight failed:[\s\S]*ExecMainStatus=226/)
    const state = Bun.spawnSync([
      "systemctl",
      "--user",
      "show",
      unit,
      "--property=ActiveState",
      "--value",
    ])
    expect(state.stdout.toString().trim()).toBe("inactive")
  } finally {
    Bun.spawnSync(["systemctl", "--user", "stop", unit])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
