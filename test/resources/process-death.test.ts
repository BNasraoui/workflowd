import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 20000
  while (!(await check())) {
    if (Date.now() > until) throw new Error("resource cleanup timed out")
    await Bun.sleep(100)
  }
}

for (const scenario of ["exit", "signal", "kill", "next-start"] as const) {
  test(`resources are labelled and removed after ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workflowd-reaper-proof-"))
    const name = `workflowd-test-${crypto.randomUUID()}`
    const ready = join(root, "ready.json")
    const path = join(root, "proof.test.ts")
    const source = `
      import { test, expect } from 'bun:test';
      import { owner } from ${JSON.stringify(join(import.meta.dir, "owner.ts"))};
      test('hold resources', async () => {
        const run = (args) => { const r = Bun.spawnSync(args); if(r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim() };
        // An assertion before creation ensures a broken guard cannot create unlabelled resources.
        expect(Bun.which('docker')).toContain('workflowd-test-run-');
        run(['docker','network','create',${JSON.stringify(name)}]);
        run(['docker','run','-d','--network',${JSON.stringify(name)},'--name',${JSON.stringify(name)},'-v','/data','alpine:3.20','sleep','300']);
        run(['systemd-run','--user','--quiet','--unit',${JSON.stringify(name)},'/bin/sleep','300']);
        const label=run(['docker','inspect','--format','{{index .Config.Labels "io.workflowd.test-run"}}',${JSON.stringify(name)}]);
        expect(label).toBe(owner());
        const mounts = JSON.parse(run(['docker','inspect','--format','{{json .Mounts}}',${JSON.stringify(name)}]));
        expect(run(['docker','volume','inspect','--format','{{index .Labels "io.workflowd.test-run"}}',mounts[0].Name])).toBe(owner());
        expect(run(['systemctl','--user','show',${JSON.stringify(name)},'--property=Environment','--value'])).toContain('WORKFLOWD_TEST_RESOURCE_RUN='+owner());
        await Bun.write(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid, guardian:Number(await Bun.file(process.env.PATH.split(':')[0]+'/guardian').text()), volume:mounts[0].Name}));
        ${scenario === "exit" ? "process.exit(0)" : "await new Promise(()=>{})"};
      }, 60000);
    `
    await writeFile(path, source)
    const child = Bun.spawn([process.execPath, "test", path], { stdout: "ignore", stderr: "pipe" })
    const logs = new Response(child.stderr).text()
    try {
      await waitFor(async () => {
        if (child.exitCode !== null && child.exitCode !== 0) throw new Error(await logs)
        return Bun.file(ready).exists()
      })
      const state: { pid: number; guardian: number; volume: string } = JSON.parse(
        await readFile(ready, "utf8"),
      )
      if (scenario === "kill") {
        const concurrent = join(root, "concurrent.test.ts")
        await writeFile(
          concurrent,
          `import { test } from 'bun:test'; test('concurrent startup',()=>{});`,
        )
        const other = Bun.spawn([process.execPath, "test", concurrent], {
          stdout: "ignore",
          stderr: "ignore",
        })
        expect(await other.exited).toBe(0)
        expect(Bun.spawnSync(["docker", "container", "inspect", name]).exitCode).toBe(0)
      }
      if (scenario === "next-start") {
        process.kill(state.guardian, "SIGKILL")
        child.kill("SIGKILL")
      }
      if (scenario !== "exit")
        process.kill(state.pid, scenario === "signal" ? "SIGTERM" : "SIGKILL")
      if (scenario === "next-start") {
        await child.exited
        await writeFile(path, `import { test } from 'bun:test'; test('startup sweep',()=>{});`)
        const next = Bun.spawn([process.execPath, "test", path], {
          stdout: "ignore",
          stderr: "pipe",
        })
        const output = await new Response(next.stderr).text()
        expect(await next.exited, output).toBe(0)
      }
      await waitFor(async () => {
        const inspect = (args: string[]) => Bun.spawnSync(args).exitCode
        const unit = Bun.spawnSync([
          "systemctl",
          "--user",
          "show",
          name,
          "--property=ActiveState",
          "--value",
        ])
          .stdout.toString()
          .trim()
        return (
          inspect(["docker", "container", "inspect", name]) !== 0 &&
          inspect(["docker", "network", "inspect", name]) !== 0 &&
          inspect(["docker", "volume", "inspect", state.volume]) !== 0 &&
          unit !== "active"
        )
      })
      if (scenario === "exit") expect(await child.exited, await logs).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
}
