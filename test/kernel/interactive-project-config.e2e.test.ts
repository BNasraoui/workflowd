import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { linkedWorktree } from "./project-config-fixture"
import { nativeModelFixture } from "../sandbox/native-fixture"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { claudeProjectArguments } from "../../src/execution/project-config"

test("interactive Claude excludes worktree hooks and MCP while retaining user hooks on launch and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "interactive-project-config-"))
  const home = join(root, "home")
  const { directory } = await linkedWorktree(root)
  const fixture = await nativeModelFixture("claude", root)
  const session = randomUUID()
  const project = join(root, "project-hook")
  const local = join(root, "local-hook")
  const mcp = join(root, "project-mcp")
  const user = join(root, "user-hook")
  const hooks = (path: string) => ({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `touch ${JSON.stringify(path)}` }] }],
    },
  })
  try {
    await mkdir(join(home, ".claude"), { recursive: true })
    await mkdir(join(directory, ".claude"))
    await writeFile(join(home, ".claude/settings.json"), JSON.stringify(hooks(user)))
    await writeFile(join(directory, ".claude/settings.json"), JSON.stringify(hooks(project)))
    await writeFile(
      join(directory, ".claude/settings.local.json"),
      JSON.stringify({ ...hooks(local), enableAllProjectMcpServers: true }),
    )
    await writeFile(
      join(directory, ".mcp.json"),
      JSON.stringify({
        mcpServers: { project_fixture: { command: "/usr/bin/touch", args: [mcp] } },
      }),
    )
    for (const [index, restricted] of [false, true, false, true].entries()) {
      const transcript = join(root, `turn-${index}.jsonl`)
      const child = Bun.spawn(["python3", resolve("test/helpers/interactive-claude.py")], {
        stdin: new Blob([
          JSON.stringify({
            binary: fixtureExecutable("claude"),
            home,
            directory,
            session,
            resume: index > 0,
            baseUrl: fixture.modelUrl,
            transcript,
            pty: join(root, `turn-${index}.pty`),
            arguments: restricted
              ? [
                  ...claudeProjectArguments,
                  "--strict-mcp-config",
                  "--mcp-config",
                  '{"mcpServers":{}}',
                ]
              : [],
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, err }).toEqual({ code: 0, err: "" })
      expect(JSON.parse(out)).toEqual({ session, exitCode: 0 })
      expect(await readFile(transcript, "utf8")).toContain("native-fixture-complete")
      expect(await Bun.file(user).exists()).toBe(true)
      for (const marker of [project, local, mcp]) {
        expect(await Bun.file(marker).exists()).toBe(!restricted)
        if (!restricted) await rm(marker)
      }
      await rm(user)
    }
    expect(fixture.requests.length).toBeGreaterThanOrEqual(4)
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
