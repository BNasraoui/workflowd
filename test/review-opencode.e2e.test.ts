import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"

const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Schema.String,
})
const Agents = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, permissions: Schema.Array(Rule) })),
})

test.skipIf(Bun.which("opencode2") === null)(
  "OpenCode loads effective review restrictions without inherited MCP servers",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "review-policy-"))
    const home = join(root, "home")
    const isolated = join(home, ".config/workflowd/opencode2")
    await mkdir(join(home, ".config/opencode"), { recursive: true })
    await mkdir(isolated, { recursive: true })
    // A lower-trust ambient config must never reach the reviewer server.
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: { servers: { ambient: { type: "remote", url: "http://127.0.0.1:1/mcp" } } },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    )
    const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
    const port = reservation.port
    await reservation.stop(true)
    const process = Bun.spawn(
      [Bun.which("opencode2")!, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: root,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: isolated,
          PATH: "/usr/bin:/bin",
          OPENCODE_CONFIG: resolve("deploy/opencode/opencode2.json"),
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_SERVER_PASSWORD: "fixture",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    const query = new URLSearchParams({ "location[directory]": root })
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${path}?${query.toString()}`, {
        headers: { authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}` },
        signal: AbortSignal.timeout(1000),
      })
      if (!response.ok) throw new Error(`OpenCode ${path}: ${response.status}`)
      return response.json()
    }
    try {
      const deadline = Date.now() + 30000
      let agents: typeof Agents.Type | undefined
      while (Date.now() < deadline) {
        try {
          agents = Schema.decodeUnknownSync(Agents)(await get("agent"))
          if (agents.data.some((agent) => agent.id === "pr-reviewer")) break
        } catch {
          /* The disposable server has not finished starting. */
        }
        await Bun.sleep(100)
      }
      for (const name of ["pr-reviewer", "pr-fixer"]) {
        const policy = agents?.data.find((agent) => agent.id === name)?.permissions
        expect(policy).toBeDefined()
        // The final default-deny rule wipes every inherited grant, including future tools.
        const deny = policy!.findLastIndex((rule) => rule.action === "*" && rule.effect === "deny")
        expect(deny).toBeGreaterThanOrEqual(0)
        expect(
          [
            ...new Set(
              policy!
                .slice(deny + 1)
                .filter((rule) => rule.effect === "allow")
                .map((rule) => rule.action),
            ),
          ].sort(),
        ).toEqual(["StructuredOutput", "glob", "grep", "list", "read"])
        for (const action of [
          "execute",
          "websearch",
          "webfetch",
          "skill",
          "shell",
          "edit",
          "subagent",
          "external_directory",
          "*_*",
        ])
          expect(policy!.some((rule) => rule.action === action && rule.effect === "deny")).toBe(
            true,
          )
      }
      const mcp = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(
        await get("mcp"),
      )
      expect(mcp.data).toEqual([])
    } finally {
      process.kill()
      await process.exited
      await rm(root, { recursive: true, force: true })
    }
  },
  40000,
)
