import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { startAppServer } from "../../src/resident/process"
import {
  launchAppServer,
  attachAppServer,
  residentUnitName,
  stopAppServer,
  sweepOrphanAppServers,
} from "../../src/resident/process"
test("owns a stdio server and closes only its subprocess", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-resident-test-"))
  const binary = join(directory, "codex")
  await writeFile(
    binary,
    '#!/usr/bin/env bun\nimport { createInterface } from "node:readline"; for await (const line of createInterface({input:process.stdin})) { const frame=JSON.parse(line); if(frame.id !== undefined) console.log(JSON.stringify({id:frame.id,result:{ok:true,args:process.argv.slice(2)}})); }\n',
    { mode: 0o700 },
  )
  const server = startAppServer({ binary, home: directory }, () => {})
  try {
    await server.initialize()
    const result = await server.rpc.request("thread/list", {})
    expect(result).toMatchObject({
      ok: true,
      args: expect.arrayContaining([
        expect.stringContaining("mcp_servers.workflowd_subscriptions="),
      ]),
    })
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("shutdown kills a live server that ignores SIGTERM within a bounded grace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-resident-stall-"))
  const binary = join(directory, "codex")
  await writeFile(
    binary,
    `#!/usr/bin/env bun
process.on("SIGTERM", () => {});
const { createInterface } = await import("node:readline");
for await (const line of createInterface({input:process.stdin})) {
  const frame = JSON.parse(line);
  if (frame.id !== undefined) console.log(JSON.stringify({id:frame.id,result:{}}));
}
`,
    { mode: 0o700 },
  )
  const server = startAppServer({ binary, home: directory }, () => {})
  try {
    await server.initialize()
    const stopped = await Promise.race([
      server.close().then(() => true),
      Bun.sleep(2500).then(() => false),
    ])
    expect(stopped).toBe(true)
    expect(() => process.kill(server.pid, 0)).toThrow()
  } finally {
    // This PID belongs to the fixture started above.
    try {
      process.kill(server.pid, "SIGKILL")
    } catch {
      // The bounded shutdown already reaped the fixture.
    }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("shutdown also kills an owned descendant when the server exits first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-resident-child-"))
  const binary = join(directory, "codex")
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdout: "pipe" });
await child.stdout.getReader().read();
const { createInterface } = await import("node:readline");
for await (const line of createInterface({input:process.stdin})) {
  const frame = JSON.parse(line);
  if (frame.id !== undefined) console.log(JSON.stringify({id:frame.id,result:{pid:child.pid}}));
}
`,
    { mode: 0o700 },
  )
  const server = startAppServer({ binary, home: directory }, () => {})
  let descendant: number | undefined
  try {
    await server.initialize()
    const { Effect, Schedule, Schema } = await import("effect")
    descendant = Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Number }))(
      await server.rpc.request("thread/list", {}),
    ).pid
    await server.close()
    const { readFile } = await import("node:fs/promises")
    const terminated = (stat: string) =>
      stat === "" || stat.split(") ")[1]?.startsWith("Z ") === true
    const stat = await Effect.runPromise(
      Effect.tryPromise(() => readFile(`/proc/${descendant}/stat`, "utf8").catch(() => "")).pipe(
        Effect.repeat({
          while: (stat) => !terminated(stat),
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("1 second"),
      ),
    )
    expect(terminated(stat)).toBe(true)
  } finally {
    if (descendant !== undefined) {
      try {
        process.kill(descendant, "SIGKILL")
      } catch {
        /* already reaped */
      }
    }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("launches a detached unit and reattaches through its WebSocket", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-resident-unit-"))
  const fakeBin = join(import.meta.dir, "fixtures/fake-systemd")
  const binary = join(import.meta.dir, "fixtures/fake-codex-app-server.ts")
  const unitPrefix = `workflowd-test-resident-${basename(root)}-`
  const runId = "agent-run-process-test"
  const unit = residentUnitName(runId, unitPrefix)
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    RESIDENT_FAKE_SYSTEMD_ROOT: join(root, "units"),
  }
  const previousPath = process.env.PATH
  const previousRoot = process.env.RESIDENT_FAKE_SYSTEMD_ROOT
  const previousStopFailure = process.env.RESIDENT_FAKE_STOP_FAIL
  const previousKillFailure = process.env.RESIDENT_FAKE_KILL_FAIL
  process.env.PATH = env.PATH
  process.env.RESIDENT_FAKE_SYSTEMD_ROOT = env.RESIDENT_FAKE_SYSTEMD_ROOT
  let server: Awaited<ReturnType<typeof launchAppServer>> | undefined
  try {
    server = await launchAppServer(
      {
        binary,
        home: join(root, "home"),
        runId,
        unitPrefix,
        launchId: "process-test-nonce",
        env,
      },
      () => {},
    )
    await server.initialize()
    const result = await server.rpc.request("thread/start", {})
    expect(result).toMatchObject({ thread: { id: "fixture-thread" } })
    const pid = server.pid
    const invocation = server.invocation
    await server.detach()
    const attached = await attachAppServer(
      { socket: server.socket, unit, launchId: "process-test-nonce", invocation },
      () => {},
    )
    await attached.initialize()
    expect(attached.pid).toBe(pid)
    await attached.close()
    await expect(
      attachAppServer(
        { socket: server.socket, unit, launchId: "wrong-nonce", invocation },
        () => {},
      ),
    ).rejects.toThrow("resident_unit_mismatch")
    await expect(
      attachAppServer(
        { socket: join(root, "missing.sock"), unit, launchId: "process-test-nonce", invocation },
        () => {},
      ),
    ).rejects.toThrow("resident socket unavailable")
    process.env.RESIDENT_FAKE_STOP_FAIL = "1"
    process.env.RESIDENT_FAKE_KILL_FAIL = "1"
    expect((await stopAppServer(unit, "process-test-nonce", invocation)).closed).toBe(true)
    delete process.env.RESIDENT_FAKE_STOP_FAIL
    delete process.env.RESIDENT_FAKE_KILL_FAIL
    const second = await launchAppServer(
      { binary, home: join(root, "home"), runId, unitPrefix, launchId: "second-nonce", env },
      () => {},
    )
    await second.initialize()
    await second.detach()
    process.env.RESIDENT_FAKE_STOP_FAIL = "1"
    process.env.RESIDENT_FAKE_KILL_FAIL = "1"
    expect(await sweepOrphanAppServers(unitPrefix, new Set())).toContain(unit)
  } finally {
    process.env.PATH = previousPath
    if (previousRoot === undefined) delete process.env.RESIDENT_FAKE_SYSTEMD_ROOT
    else process.env.RESIDENT_FAKE_SYSTEMD_ROOT = previousRoot
    if (previousStopFailure === undefined) delete process.env.RESIDENT_FAKE_STOP_FAIL
    else process.env.RESIDENT_FAKE_STOP_FAIL = previousStopFailure
    if (previousKillFailure === undefined) delete process.env.RESIDENT_FAKE_KILL_FAIL
    else process.env.RESIDENT_FAKE_KILL_FAIL = previousKillFailure
    await server?.detach()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
