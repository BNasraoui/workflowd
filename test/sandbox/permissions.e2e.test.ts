import { expect, test } from "bun:test"
import { realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startSandboxOpenCode } from "../../src/sandbox/opencode"
import { command, runnerFixture } from "./harness"
import { Schema } from "effect"

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
  } finally {
    await server?.close()
    await model.stop(true)
    await runner.close()
  }
}, 300_000)
