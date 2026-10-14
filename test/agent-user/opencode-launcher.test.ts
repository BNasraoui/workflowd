import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("built OpenCode launcher validates service.json before launching with --service", async () => {
  const home = await mkdtemp(join(tmpdir(), "workflowd-opencode-launcher-"))
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../src/agent-host/opencode-server.ts")],
      target: "bun",
      outdir: join(home, "build"),
    })
    expect(build.success).toBe(true)
    // Substitute only OS identity and child execution in the launcher subprocess.
    // The bundled main block, environment construction and file validation are real.
    const preload = join(home, "fixture.ts")
    await writeFile(
      preload,
      `
      process.getuid = () => 61002;
      process.getgid = () => 61000;
      process.getgroups = () => [61000];
      const spawn = Bun.spawn;
      Bun.spawn = (argv, options) => {
        console.log(JSON.stringify({ argv, env: options.env }));
        return spawn([process.execPath, "-e", "process.exit(0)"], options);
      };
    `,
    )
    const launch = async () => {
      const child = Bun.spawn([process.execPath, "--preload", preload, build.outputs[0]!.path], {
        env: {
          WORKFLOWD_AGENT_UID: "61002",
          WORKFLOWD_AGENT_GID: "61000",
          WORKFLOWD_AGENT_HOME: home,
          WORKFLOWD_AGENT_GIT_NAME: "Fixture Agent",
          WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const config = join(home, ".config/opencode")
    await mkdir(config, { recursive: true })
    for (const contents of [undefined, "{", "{}", '{"password":""}']) {
      if (contents !== undefined) await writeFile(join(config, "service.json"), contents)
      const result = await launch()
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("requires a service.json with server authentication")
      expect(result.stdout).toBe("")
    }
    await writeFile(join(config, "service.json"), '{"password":"fixture-secret"}', { mode: 0o600 })
    const result = await launch()
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    const invoked = JSON.parse(result.stdout)
    expect(invoked.argv).toEqual([
      "/usr/local/bin/opencode2",
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4097",
    ])
    expect(invoked.env.XDG_CONFIG_HOME).toBe(join(home, ".config"))
    expect(invoked.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(invoked.env.OPENCODE_PASSWORD).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 15_000)
