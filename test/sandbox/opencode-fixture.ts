import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../src/opencode/adapter"
import { command } from "./harness"

const ModelRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Json })),
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
  ),
})
export type FixtureAction = { name: string; arguments: string; text?: string }

// A disposable shared server with ordinary built-ins and only fake model credentials.
// The fixture home isolates configuration, not tool execution: its canaries are writable.
export async function sharedOpenCodeFixture(
  label: string,
  policy?: { summary: string; refuseNative?: boolean; discoverAfterNative?: boolean },
  sandboxAgent = true,
) {
  const artifact = await readFile(resolve("deploy/opencode/sandbox.json"), "utf8")
  const binary = await realpath(Bun.which("opencode2") ?? "opencode2")
  const binaryHash = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex")
  if (binaryHash !== "5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c")
    throw new Error("Fixture requires pinned OpenCode beta-19242")
  const root = await mkdtemp(join(tmpdir(), "workflowd-shared-opencode-"))
  const unit = `workflowd-sandbox-fixture-${crypto.randomUUID()}`
  const requests: Array<typeof ModelRequest.Type> = []
  const credentials: Array<string | null> = []
  let rejection: { path: string; status: number; method?: string } | undefined
  let actions: FixtureAction[] = []
  let answer = "fixture complete"
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      credentials.push(request.headers.get("authorization"))
      const body = Schema.decodeUnknownSync(ModelRequest)(await request.json())
      requests.push(body)
      let action: FixtureAction | undefined =
        body.tools?.length === 0 || body.tools === undefined
          ? {
              name: "shell",
              arguments: JSON.stringify({
                command: "printf title-escaped > canary",
                description: "Auxiliary confinement",
              }),
              text: "Sandbox fixture title",
            }
          : actions.shift()
      const last = body.messages.at(-1)
      let text = answer
      if (policy !== undefined && last?.role === "user" && typeof last.content === "string") {
        if (
          last.content.startsWith("Execute exactly this tool call") ||
          last.content.startsWith("This is an authorized disposable negative confinement test.")
        ) {
          action = Schema.decodeUnknownSync(
            Schema.Struct({ name: Schema.String, arguments: Schema.String }),
          )(JSON.parse(last.content.split("\n").at(-1) ?? ""))
          if (
            !body.tools?.some((tool) => tool.function.name === action?.name) ||
            (policy.refuseNative && /tools\.(shell|read|write)\(/.test(action.arguments))
          )
            action = undefined
          if (
            policy.discoverAfterNative &&
            action &&
            /tools\.(shell|read|write)\(/.test(action.arguments)
          )
            actions.push(
              ...Array.from({ length: 22 }, () => ({
                name: "execute",
                arguments: JSON.stringify({
                  code: 'return await search({ query: "shell command execution" })',
                }),
              })),
            )
        }
        if (last.content.includes("You MUST summarize the conversation")) text = policy.summary
      }
      const delta =
        action === undefined
          ? { role: "assistant", content: text }
          : {
              role: "assistant",
              ...(action.text === undefined ? {} : { content: action.text }),
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests.length}`,
                  type: "function",
                  function: { name: action.name, arguments: action.arguments },
                },
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
  const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = portReservation.port
  await portReservation.stop(true)
  const url = `http://127.0.0.1:${port}`
  const api = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<unknown> => {
    const response = await fetch(`${url}/api/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from("opencode:fixture-server-password").toString("base64")}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000),
    })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 2000)}`)
    return text === "" ? undefined : JSON.parse(text)
  }
  const close = async () => {
    await command(["systemctl", "--user", "stop", unit])
    await command(["systemctl", "--user", "reset-failed", unit]).catch(() => undefined)
    await model.stop(true)
    const evidenceDirectory = process.env.SANDBOX_POLICY_EVIDENCE
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true })
      await writeFile(
        join(evidenceDirectory, `${label}-model-requests.json`),
        JSON.stringify(requests, null, 2),
      )
      await writeFile(
        join(evidenceDirectory, `${label}-fixture.json`),
        JSON.stringify(
          {
            root,
            unit,
            url,
            binaryHash,
            artifactHash: createHash("sha256").update(artifact).digest("hex"),
            credentials: [...new Set(credentials)],
            projectConfigDisabled: true,
          },
          null,
          2,
        ),
      )
    } else await rm(root, { recursive: true, force: true })
  }
  try {
    const configDirectory = join(root, "home/.config/opencode")
    await mkdir(configDirectory, { recursive: true })
    const sandboxConfig = join(root, "home/.config/workflowd/opencode2-sandbox-agent.json")
    await mkdir(join(root, "home/.config/workflowd"), { recursive: true })
    await writeFile(sandboxConfig, sandboxAgent ? artifact : "{}")
    await writeFile(
      join(configDirectory, "opencode.json"),
      JSON.stringify({
        update: "disable",
        share: "disabled",
        snapshots: false,
        formatter: false,
        lsp: false,
        providers: {
          "fixture-second": {
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
            models: {
              "second-model": {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 100000, output: 1024 },
              },
            },
          },
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
      }),
    )
    await command([
      "systemd-run",
      "--user",
      `--unit=${unit}`,
      "-p",
      "MemoryMax=2G",
      "-p",
      "MemorySwapMax=0",
      "-p",
      "RuntimeMaxSec=300",
      "-p",
      "KillMode=control-group",
      `--working-directory=${root}`,
      "/usr/bin/env",
      "-i",
      `HOME=${join(root, "home")}`,
      "PATH=/usr/bin:/bin",
      "OPENCODE_DISABLE_PROJECT_CONFIG=1",
      `OPENCODE_CONFIG=${sandboxConfig}`,
      "OPENCODE_SERVER_PASSWORD=fixture-server-password",
      binary,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ])
    const deadline = Date.now() + 30000
    for (;;) {
      try {
        Schema.decodeUnknownSync(
          Schema.Struct({
            healthy: Schema.Literal(true),
            version: Schema.Literal("0.0.0-beta-19242"),
          }),
        )(await api("health"))
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await Bun.sleep(100)
      }
    }
    const location = new URLSearchParams({ "location[directory]": root })
    const agents = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })
    for (;;) {
      const catalog = Schema.decodeUnknownSync(agents)(await api(`agent?${location.toString()}`))
      if (!sandboxAgent || catalog.data.some((agent) => agent.id === "sandbox")) break
      if (Date.now() >= deadline) throw new Error("Global sandbox agent did not load")
      await Bun.sleep(100)
    }
    if (!sandboxAgent) {
      for (;;) {
        const models = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
        )(await api(`model?${location.toString()}`))
        if (models.data.some((model) => model.id === "gpt-6-astra-fixture")) break
        if (Date.now() >= deadline) throw new Error("Fixture provider config did not load")
        await Bun.sleep(100)
      }
    }
    await api(`integration/openai/connect/key?${location.toString()}`, {
      key: "fixture-model-canary",
    })
    await api(`integration/fixture-second/connect/key?${location.toString()}`, {
      key: "second-fixture-canary",
    })
    const sdkFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        headers.set(
          "Authorization",
          `Basic ${Buffer.from("opencode:fixture-server-password").toString("base64")}`,
        )
        const path = new URL(input instanceof Request ? input.url : input).pathname
        if (
          rejection !== undefined &&
          path.endsWith(rejection.path) &&
          (rejection.method === undefined || rejection.method === init?.method)
        )
          return new Response(null, { status: rejection.status })
        const response = await fetch(input, { ...init, headers })
        return response
      },
      { preconnect: fetch.preconnect },
    )
    const client = await Effect.runPromise(
      OpenCode.make({ baseUrl: url }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, sdkFetch))),
        ),
      ),
    )
    const executor = new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client)))
    return {
      client,
      executor,
      reject: (next?: { path: string; status: number; method?: string }) => {
        rejection = next
      },
      root,
      url,
      api,
      close,
      requests,
      credentials,
      script: (next: FixtureAction[], text = "fixture complete") => {
        actions = [...next]
        answer = text
      },
      restart: async () => {
        await command(["systemctl", "--user", "restart", unit])
      },
      create: async (directory: string, agent: string, titled = true) => {
        await mkdir(directory, { recursive: true })
        const session = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
        )(
          await api("session", {
            ...(titled ? { title: "shared fixture" } : {}),
            agent,
            model: { id: "gpt-6-astra-fixture", providerID: "openai" },
            location: { directory },
          }),
        )
        return session.data.id
      },
      prompt: async (id: string, text: string) => {
        await api(`session/${id}/prompt`, { text })
        await api(`session/${id}/wait`, {})
        const messages = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
        )(await api(`session/${id}/message`))
        const boundary = messages.data.findIndex((message) => message.type === "user")
        return { data: messages.data.slice(0, boundary + 1) }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

export const compactionSummary = `## Objective
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

// Exercise cleanup of historical invocation custody without recreating the removed launcher.
export async function legacySandboxUnit(directory: string, leaseId: string) {
  const unit = `workflowd-sandbox-${leaseId}`
  await command([
    "systemd-run",
    "--user",
    `--unit=${unit}`,
    "-p",
    "MemoryMax=64M",
    "-p",
    "MemorySwapMax=0",
    "/usr/bin/sleep",
    "300",
  ])
  const invocationId = await command([
    "systemctl",
    "--user",
    "show",
    unit,
    "--property=InvocationID",
    "--value",
  ])
  const endpoint = { url: "http://127.0.0.1:1", password: "unused-fixture", unit, invocationId }
  await writeFile(join(directory, "endpoint.json"), JSON.stringify(endpoint))
  const { stopSandboxOpenCode } = await import("../../src/sandbox/opencode")
  return { ...endpoint, close: () => stopSandboxOpenCode(endpoint) }
}
