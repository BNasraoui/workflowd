import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { label } from "./backend"
import { owner } from "./owner"

test("a real pinned stale volume warns at startup and cannot fail another suite", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinned-review-"))
  const name = `workflowd-test-pinned-${crypto.randomUUID()}`
  const docker = Bun.which("docker", { PATH: process.env.WORKFLOWD_TEST_ORIGINAL_PATH! })!
  const dead = owner().split(".")
  dead[6] = "0"
  const run = (args: string[]) => {
    const result = Bun.spawnSync(args)
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  try {
    run([docker, "volume", "create", "--label", `${label}=${dead.join(".")}`, name])
    // The holder has the live outer test owner; only the volume is eligible for the child sweep.
    run([
      docker,
      "create",
      "--label",
      `${label}=${owner()}`,
      "--name",
      name,
      "--mount",
      `type=volume,src=${name},dst=/data`,
      "alpine:3.20",
      "true",
    ])
    expect(Bun.spawnSync([docker, "volume", "rm", name]).exitCode).not.toBe(0)
    const path = join(root, "proof.test.ts")
    await writeFile(
      path,
      `import { test } from 'bun:test'; test('uses docker', () => { if (Bun.spawnSync(['docker','version']).exitCode) throw Error('docker unavailable'); });`,
    )
    const child = Bun.spawn([process.execPath, "test", path], { stdout: "ignore", stderr: "pipe" })
    const output = await new Response(child.stderr).text()
    expect(await child.exited, output).toBe(0)
    expect(output).toContain(
      `Startup cleanup warning: AggregateError: Test resources survived cleanup: volume:${name}`,
    )
    expect(
      run([docker, "volume", "inspect", "--format", `{{index .Labels "${label}"}}`, name]),
    ).toBe(dead.join("."))
  } finally {
    // These exact names were created above with explicit run ownership.
    Bun.spawnSync([docker, "container", "rm", "--force", name])
    Bun.spawnSync([docker, "volume", "rm", name])
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
