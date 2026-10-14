import { expect } from "bun:test"
import { chmod, chown, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"

export async function openCodePublisher(
  home: string,
  workspace: string,
  env: Record<string, string>,
  asAgent: (argv: string[]) => string[],
  shell: string,
) {
  const serverPassword = crypto.randomUUID()
  let sent = false
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          tools: Schema.optional(
            Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
          ),
        }),
      )(await request.json())
      const names = body.tools?.map((tool) => tool.function.name) ?? []
      const tool = !sent && names.length > 0
      if (tool) sent = true
      const name = names.includes("shell") ? "shell" : "execute"
      const args =
        name === "shell"
          ? { command: shell, description: "Publish fixture" }
          : {
              code: `return await tools.shell(${JSON.stringify({ command: shell, description: "Publish fixture" })})`,
            }
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-call",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { role: "assistant", content: "fixture complete" }
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      return new Response(
        chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const config = join(home, ".config/opencode")
  expect(await Bun.spawn(asAgent(["mkdir", "-p", config]), { env }).exited).toBe(0)
  const configFile = join(config, "opencode.json")
  await writeFile(
    configFile,
    JSON.stringify({
      update: "disable",
      share: "disabled",
      snapshots: false,
      formatter: false,
      lsp: false,
      providers: {
        fixture: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${model.url.toString()}v1` },
          models: {
            fixture: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 1024 },
            },
          },
        },
      },
    }),
    { mode: 0o644 },
  )
  await chmod(configFile, 0o644)
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  const shellEnv = {
    ...env,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  }
  await writeFile(
    join(home, ".config/opencode/service.json"),
    JSON.stringify({ password: serverPassword }),
    { mode: 0o600 },
  )
  await chown(
    join(home, ".config/opencode/service.json"),
    Number(env.TEST_AGENT_UID ?? process.getuid!()),
    Number(env.TEST_AGENT_GID ?? process.getgid!()),
  )
  const child = Bun.spawn(
    asAgent([
      Bun.which("opencode2")!,
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ]),
    {
      env: {
        ...shellEnv,
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      },
      cwd: workspace,
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/${path}?${new URLSearchParams({ "location[directory]": workspace }).toString()}`,
      {
        method: body === undefined ? "GET" : path.endsWith("/environment") ? "PUT" : "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      },
    )
    if (!response.ok)
      throw new Error(
        `fixture OpenCode API ${path} ${response.status}: ${(await response.text()).slice(0, 2000)}`,
      )
    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : undefined
  }
  const close = async () => {
    child.kill("SIGKILL")
    await child.exited
    await model.stop(true)
  }
  try {
    const deadline = Date.now() + 15000
    for (;;) {
      if (
        await api("model").then(
          (value) => JSON.stringify(value).includes('"id":"fixture"'),
          () => false,
        )
      )
        break
      if (Date.now() > deadline) throw new Error("fixture OpenCode startup timed out")
      await Bun.sleep(50)
    }
    const serverEnv = await readFile(`/proc/${child.pid}/environ`, "utf8")
    expect(serverEnv).not.toContain("OPENCODE_SERVER_PASSWORD=")
    expect(serverEnv).not.toContain("OPENCODE_PASSWORD=")
    await api("integration/fixture/connect/key", { key: "synthetic" })
    const session = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
    )(
      await api("session", {
        location: { directory: workspace },
        agent: "build",
        model: { id: "fixture", providerID: "fixture" },
      }),
    )
    return {
      sessionId: session.data.id,
      setEnvironment: async (variables: Readonly<Record<string, string>>) => {
        await api(`session/${session.data.id}/environment`, {
          variables: { ...variables, ...shellEnv },
        })
        // Read the live database as the agent UID, including SQLite's WAL view.
        // The pinned SessionEnvironment service is an in-memory Map, not a table.
        const probe = Bun.spawn(
          asAgent([
            process.execPath,
            "-e",
            `
          import { Database } from "bun:sqlite";
          const db = new Database(process.env.TEST_DB, { readonly: true });
          const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
          const found = tables.some(({name}) => JSON.stringify(db.query('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()).includes(process.env.TEST_CAPABILITY));
          db.close(); console.log(JSON.stringify({ readable: true, capabilityStored: found }));
        `,
          ]),
          {
            env: {
              ...shellEnv,
              TEST_DB: join(home, ".local/share/opencode/opencode.db"),
              TEST_CAPABILITY: variables.WORKFLOWD_WORKER_CAPABILITY!,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const result = await new Response(probe.stdout).text()
        expect(await probe.exited).toBe(0)
        expect(JSON.parse(result)).toEqual({ readable: true, capabilityStored: false })
      },
      prompt: async () => {
        await api(`session/${session.data.id}/prompt`, { text: "Publish the fixture" })
        await api(`session/${session.data.id}/wait`, {})
        if (!(await Bun.file(join(workspace, "sha")).exists()))
          throw new Error(JSON.stringify(await api(`session/${session.data.id}/message`)))
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
