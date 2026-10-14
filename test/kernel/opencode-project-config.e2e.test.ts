import { linkedWorktree } from "./project-config-fixture"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const units = [
  "opencode-server.service.d/10-disable-project-config.conf",
  "opencode2-server.service.d/10-disable-project-config.conf",
  "opencode2-reviewer.service",
]

test("every shipped OpenCode server excludes project configuration", async () => {
  for (const unit of units) {
    const text = await readFile(join(import.meta.dir, "../../deploy/systemd", unit), "utf8")
    expect(text).toContain("Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1")
    expect(text).toContain("Environment=OPENCODE_CONFIG_PROJECT_DISABLE=1")
  }
})

test("installed OpenCode excludes project plugin initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-opencode-config-"))
  const { directory } = await linkedWorktree(root)
  const marker = join(root, "project-plugin-ran")
  await mkdir(join(directory, ".opencode/plugins"), { recursive: true })
  await writeFile(
    join(directory, ".opencode/plugins/fixture.ts"),
    `await Bun.write(${JSON.stringify(marker)}, "ran"); export default async () => ({});`,
  )
  await writeFile(
    join(directory, ".opencode/opencode.json"),
    JSON.stringify({ plugins: ["./plugins/fixture.ts"] }),
  )
  const binary = Bun.which("opencode2")
  if (binary === null) throw new Error("Missing pinned OpenCode fixture CLI")
  try {
    for (const disabled of [false, true]) {
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      const port = reservation.port!
      await reservation.stop(true)
      const home = join(root, disabled ? "isolated" : "control")
      await mkdir(join(home, ".config/opencode"), { recursive: true })
      await writeFile(
        join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          agents: { "fixture-global": { description: "Configuration ready", mode: "primary" } },
        }),
      )
      const child = Bun.spawn(
        [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, "data"),
            XDG_CACHE_HOME: join(home, "cache"),
            XDG_STATE_HOME: join(home, "state"),
            OPENCODE_SERVER_PASSWORD: "fixture-only",
            ...(disabled
              ? { OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1" }
              : {}),
          },
          stdout: "ignore",
          stderr: Bun.file(join(root, "stderr")),
        },
      )
      try {
        const deadline = Date.now() + 20000
        const query = new URLSearchParams({ "location[directory]": directory })
        for (;;) {
          const response = await fetch(`http://127.0.0.1:${port}/api/agent?${query.toString()}`, {
            headers: {
              Authorization: `Basic ${Buffer.from("opencode:fixture-only").toString("base64")}`,
            },
            signal: AbortSignal.timeout(1000),
          }).catch(() => undefined)
          if (response?.ok) {
            if ((await response.text()).includes('"fixture-global"')) break
          }
          if (Date.now() >= deadline) throw new Error("OpenCode fixture did not initialize")
          await Bun.sleep(100)
        }
        expect({
          ran: await Bun.file(marker).exists(),
          stderr: await readFile(join(root, "stderr"), "utf8"),
        }).toMatchObject({ ran: !disabled })
      } finally {
        child.kill("SIGKILL")
        await child.exited
      }
      await rm(marker, { force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
