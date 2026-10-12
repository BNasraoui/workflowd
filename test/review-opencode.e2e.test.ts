import { randomUUID } from "node:crypto"
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  "OpenCode ignores ambient and PR-supplied config and plugins",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "review-policy-"))
    expect(
      await Bun.spawn(["git", "init", "-q", root], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0)
    const home = join(root, "home")
    const isolated = join(home, ".config/workflowd-reviewer")
    await mkdir(join(home, ".config/opencode"), { recursive: true })
    await mkdir(join(isolated, "opencode"), { recursive: true })
    await writeFile(
      join(isolated, "opencode2.json"),
      await Bun.file("deploy/opencode/opencode2.json").text(),
    )
    // A lower-trust ambient config must never reach the reviewer server.
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: { servers: { ambient: { type: "remote", url: "http://127.0.0.1:1/mcp" } } },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    )
    const pluginMarker = join(root, "plugin-loaded")
    const canaryConfig = (id: string) => ({
      agents: {
        [id]: { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      },
      mcp: { servers: { [id]: { type: "remote", url: "http://127.0.0.1:1/mcp" } } },
    })
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify(canaryConfig("project-root-canary")),
    )
    await mkdir(join(root, ".opencode/plugins"), { recursive: true })
    await mkdir(join(root, ".opencode/plugin"), { recursive: true })
    await writeFile(
      join(root, ".opencode/opencode.json"),
      JSON.stringify(canaryConfig("project-dir-canary")),
    )
    const plugin = `await Bun.write(${JSON.stringify(pluginMarker)}, "loaded"); export const Canary = async () => ({})`
    await writeFile(join(root, ".opencode/plugins/canary.ts"), plugin)
    await writeFile(join(root, ".opencode/plugin/canary.ts"), plugin)
    const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
    const port = reservation.port
    await reservation.stop(true)
    const unit =
      Bun.which("systemd-run") !== null && Bun.env.XDG_RUNTIME_DIR
        ? `workflowd-review-fixture-${randomUUID()}`
        : undefined
    const process = Bun.spawn(
      [
        ...(unit !== undefined
          ? [
              "systemd-run",
              "--user",
              "--wait",
              "--pipe",
              "--collect",
              `--unit=${unit}`,
              `--working-directory=${root}`,
              "-p",
              "RuntimeMaxSec=45",
              "-p",
              "MemoryMax=6G",
              "-p",
              "MemorySwapMax=0",
              "-p",
              "PrivateUsers=yes",
              "-p",
              `ReadOnlyPaths=${isolated}`,
              "/usr/bin/env",
              "-i",
              `HOME=${home}`,
              `XDG_CONFIG_HOME=${isolated}`,
              `OPENCODE_CONFIG=${join(isolated, "opencode2.json")}`,
              "PATH=/usr/bin:/bin",
              "OPENCODE_DISABLE_PROJECT_CONFIG=1",
              "OPENCODE_CONFIG_PROJECT_DISABLE=1",
              "OPENCODE_SERVER_PASSWORD=fixture",
            ]
          : []),
        Bun.which("opencode2")!,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: isolated,
          PATH: "/usr/bin:/bin",
          OPENCODE_CONFIG: join(isolated, "opencode2.json"),
          ...(Bun.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: Bun.env.XDG_RUNTIME_DIR } : {}),
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
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
      expect(agents?.data.some((agent) => agent.id.endsWith("-canary"))).toBe(false)
      expect(await Bun.file(pluginMarker).exists()).toBe(false)
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
      if (unit !== undefined)
        await Bun.spawn(["systemctl", "--user", "stop", unit], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited
      process.kill()
      await process.exited
      await rm(root, { recursive: true, force: true })
    }
  },
  40000,
)
