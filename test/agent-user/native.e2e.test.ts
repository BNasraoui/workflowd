import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"
import { serveCredentialHost } from "../../src/agent-host/server"

// A controller cannot turn the credential service into a generic root launcher.
test("native host refuses an unsupported launch profile without releasing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-host-"))
  const uid = process.getuid!()
  const gid = process.getgid!()
  const store = join(root, "store")
  await mkdir(store, { mode: 0o710 })
  const canonical = join(store, "auth.json")
  await writeFile(canonical, "synthetic", { mode: 0o660 })
  await chmod(canonical, 0o660)
  const benLink = join(root, "ben-link")
  const agentLink = join(root, "agent-link")
  await symlink(canonical, benLink)
  await symlink(canonical, agentLink)
  const socketPath = join(root, "host.sock")
  const host = await serveCredentialHost(socketPath, {
    root: store,
    ownerUid: uid,
    groupGid: gid,
    controllerUid: uid,
    agentUid: uid,
    codex: { canonical, benLink, agentLink },
    claude: { canonical, benLink, agentLink },
    consumerExecutables: [],
  })
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(socketPath)
      let text = ""
      socket.on("error", reject)
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({
            operation: "start",
            profile: "root-shell",
            runId: "agent-run-forged",
            command: ["/bin/sh"],
            user: 0,
          }) + "\n",
        ),
      )
      socket.on("data", (chunk) => {
        text += chunk.toString()
        if (text.includes("\n")) {
          socket.destroy()
          resolve(text)
        }
      })
    })
    expect(JSON.parse(response)).toEqual({ admitted: false, reason: "host_request_refused" })
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { chown, readFile, realpath } from "node:fs/promises"
import { nativeModelFixture } from "../sandbox/native-fixture"
import { Schema } from "effect"
import { OwnedProcess, type HostRequest } from "../../src/agent-host/protocol"

if (process.env.WORKFLOWD_AGENT_TEST_BEN_UID) {
  test("two-UID native services retain custody across controller restart and refuse forged launches", async () => {
    expect(process.getuid!()).toBe(0)
    const controllerUid = Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID)
    const agentUid = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID)
    const groupGid = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID)
    expect(controllerUid).not.toBe(agentUid)
    const root = await mkdtemp(join(tmpdir(), "native-services-"))
    await chmod(root, 0o755)
    const controller = join(root, "controller")
    const home = join(root, "agent")
    const workspaceRoot = join(root, "workspaces")
    const custodyRoot = join(root, "custody")
    const ioRoot = join(root, "io")
    const store = join(root, "store")
    for (const [path, uid, mode] of [
      [controller, controllerUid, 0o700],
      [home, agentUid, 0o700],
      [workspaceRoot, agentUid, 0o700],
      [custodyRoot, 0, 0o700],
      [ioRoot, 0, 0o711],
      [store, 0, 0o710],
    ] as const) {
      await mkdir(path, { mode })
      await chown(path, uid, groupGid)
    }
    const canary = join(controller, "controller.db")
    await writeFile(canary, "controller-only", { mode: 0o600 })
    await chown(canary, controllerUid, groupGid)
    const login = async (kind: string, name: string) => {
      for (const [base, uid] of [
        [controller, controllerUid],
        [home, agentUid],
      ] as const) {
        await mkdir(join(base, kind), { mode: 0o700 })
        await chown(join(base, kind), uid, groupGid)
      }
      const canonical = join(store, name)
      await writeFile(canonical, '{"OPENAI_API_KEY":"fixture-only"}', { mode: 0o660 })
      await chmod(canonical, 0o660)
      await chown(canonical, 0, groupGid)
      const benLink = join(controller, kind, name)
      const agentLink = join(home, kind, name)
      await symlink(canonical, benLink)
      await symlink(canonical, agentLink)
      return { canonical, benLink, agentLink }
    }
    const codex = await nativeModelFixture("codex", root)
    const claude = await nativeModelFixture("claude", root)
    const worker = join(root, "worker.js")
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../src/kernel/codex-worker.ts")],
      target: "bun",
      minify: false,
    })
    expect(build.success).toBe(true)
    await writeFile(worker, await build.outputs[0]!.text(), { mode: 0o644 })
    const policy = {
      root: store,
      ownerUid: 0,
      groupGid,
      controllerUid,
      agentUid,
      codex: await login(".codex", "auth.json"),
      claude: await login(".claude", ".credentials.json"),
      consumerExecutables: [],
      launch: {
        custodyRoot,
        ioRoot,
        home,
        workspaceRoot,
        bun: await realpath(process.execPath),
        worker,
        codex: codex.binary,
        claude: claude.binary,
      },
    }
    const path = join(root, "host.sock")
    let host = await serveCredentialHost(path, policy)
    const units = new Set<string>()
    const call = async (request: HostRequest, uid = controllerUid): Promise<unknown> => {
      const child = Bun.spawn(
        [
          "/usr/bin/setpriv",
          "--reuid",
          String(uid),
          "--regid",
          String(groupGid),
          "--clear-groups",
          process.execPath,
          "--eval",
          `import {requestAgentHost} from ${JSON.stringify(join(import.meta.dir, "../../src/agent-host/client.ts"))}; console.log(JSON.stringify(await requestAgentHost(process.argv[1],JSON.parse(process.argv[2]))));`,
          path,
          JSON.stringify(request),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (status !== 0) throw new Error(stderr)
      return JSON.parse(stdout)
    }
    try {
      for (const [client, fixture] of [
        ["codex", codex],
        ["claude", claude],
      ] as const) {
        const runId = `agent-run-${client}-${crypto.randomUUID()}`
        const start = {
          operation: "start" as const,
          runId,
          profile: client,
          directory: workspaceRoot,
          prompt: "Run the fixture tool then finish.",
          model: client === "codex" ? "gpt-5.4" : "claude-opus-4-6",
        }
        const proof = join(workspaceRoot, `${client}-proof`)
        fixture.actions.push({
          name: client === "codex" ? "exec_command" : "Bash",
          arguments:
            client === "codex"
              ? {
                  cmd: `id -u > '${proof}'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi; sleep 300`,
                  yield_time_ms: 1000,
                }
              : {
                  command: `id -u > '${proof}'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi; sleep 300`,
                  timeout: 1000,
                },
        })
        fixture.holdAfter(1)
        const process = Schema.decodeUnknownSync(OwnedProcess)(await call(start))
        units.add(process.unit)
        expect(process.uid).toBe(agentUid)
        const deadline = Date.now() + 45000
        while (!(await readFile(proof, "utf8").catch(() => "")).includes("denied")) {
          if (Date.now() > deadline) throw new Error(`${client} native tool did not reach proof`)
          await Bun.sleep(100)
        }
        expect(await readFile(proof, "utf8")).toBe(`${agentUid}\ndenied\n`)
        await host.close()
        await rm(path, { force: true })
        host = await serveCredentialHost(path, policy)
        const attached = Schema.decodeUnknownSync(OwnedProcess)(
          await call({ operation: "inspect", runId }),
        )
        expect(attached.invocationId).toBe(process.invocationId)
        expect(attached.pid).toBe(process.pid)
        expect(attached.active).toBe(true)
        expect(Schema.decodeUnknownSync(OwnedProcess)(await call(start)).invocationId).toBe(
          process.invocationId,
        )
        await expect(call({ operation: "stop", runId, launchId: "forged" })).rejects.toThrow(
          "host_request_refused",
        )
        await expect(call(start, agentUid)).rejects.toThrow()
        const stopped = Schema.decodeUnknownSync(OwnedProcess)(
          await call({ operation: "stop", runId, launchId: process.launchId }),
        )
        expect(stopped.active).toBe(false)
        expect(await readFile(`/proc/${process.pid}/status`, "utf8").catch(() => null)).toBeNull()
        const priorCount = fixture.requests.length
        await rm(policy[client].agentLink)
        await expect(call({ ...start, runId: `${runId}-broken` })).rejects.toThrow(
          "shared_credential_link_broken",
        )
        expect(fixture.requests.length).toBe(priorCount)
        await symlink(policy[client].canonical, policy[client].agentLink)
      }
    } finally {
      for (const unit of units) {
        await Bun.spawn(["systemctl", "stop", unit], { stdout: "ignore", stderr: "ignore" }).exited
        await Bun.spawn(["systemctl", "reset-failed", unit], { stdout: "ignore", stderr: "ignore" })
          .exited
      }
      await host.close()
      await codex.close()
      await claude.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 150000)
}
