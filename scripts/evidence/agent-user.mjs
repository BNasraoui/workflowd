#!/usr/bin/env bun
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, chown, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { serveCredentialHost } from "../../src/agent-host/server.ts"
import {
  probeCodexCredentialSharing,
  probeInstalledRefresh,
} from "../../test/agent-user/harness.ts"

// This prerequisite uses disposable identities only. It does not provision a host or
// claim that production native dispatch already uses the system manager.
async function command(argv) {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      killSignal: "SIGKILL",
    })
    let output = ""
    let diagnostic = ""
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(0, 2048)
    })
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(`supervision_command_failed:${argv[0]}:exit=${code}:${diagnostic.trim()}`),
          ),
    )
  })
}

async function probeSupervision() {
  const controllerUid = Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID)
  const agentUid = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID)
  const groupGid = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID)
  assert(process.getuid() === 0, "supervision_probe_requires_disposable_root")
  assert(
    [controllerUid, agentUid, groupGid].every((id) => Number.isSafeInteger(id) && id > 0),
    "supervision_probe_requires_fixture_identities",
  )
  assert.notEqual(controllerUid, agentUid)
  const root = await mkdtemp(join(tmpdir(), "workflowd-supervision-"))
  const unit = `workflowd-supervision-${root.split("-").at(-1)}.service`
  const nonce = crypto.randomUUID()
  let host
  let launched = false
  const agentHome = join(root, "agent")
  const controllerHome = join(root, "controller")
  const store = join(root, "store")
  const socket = join(root, "control.sock")
  const asUid = (uid, argv) => [
    "/usr/bin/setpriv",
    "--reuid",
    String(uid),
    "--regid",
    String(groupGid),
    "--clear-groups",
    ...argv,
  ]
  const inspect = async () => {
    const output = await command([
      "systemctl",
      "show",
      unit,
      "--property=InvocationID,Description,MainPID,ActiveState,User",
      "--no-pager",
    ])
    return Object.fromEntries(
      output.split("\n").map((line) => {
        const i = line.indexOf("=")
        return [line.slice(0, i), line.slice(i + 1)]
      }),
    )
  }
  try {
    // Bun resolves entrypoints by reading their directory; only public fixture
    // code lives here. The separate controller and agent homes stay private.
    await chmod(root, 0o755)
    for (const [directory, uid, mode] of [
      [agentHome, agentUid, 0o700],
      [controllerHome, controllerUid, 0o700],
      [store, 0, 0o710],
    ]) {
      await mkdir(directory, { mode })
      await chown(directory, uid, groupGid)
      await chmod(directory, mode)
    }
    const canonical = join(store, "auth.json")
    await writeFile(canonical, "synthetic-supervision-credential", { mode: 0o660 })
    await chown(canonical, 0, groupGid)
    await chmod(canonical, 0o660)
    const login = {
      canonical,
      benLink: join(controllerHome, "auth.json"),
      agentLink: join(agentHome, "auth.json"),
    }
    await symlink(canonical, login.benLink)
    await symlink(canonical, login.agentLink)
    const canary = join(controllerHome, "controller.db")
    await writeFile(canary, "synthetic-controller-canary", { mode: 0o600 })
    await chown(canary, controllerUid, groupGid)
    const policy = {
      root: store,
      ownerUid: 0,
      groupGid,
      controllerUid,
      agentUid,
      codex: login,
      claude: login,
      consumerExecutables: [],
    }
    host = await serveCredentialHost(socket, policy)
    const clientScript = join(root, "client.mjs")
    await writeFile(
      clientScript,
      `import { connect } from "node:net";
const socket = connect(process.argv[2]);
let data = "";
socket.setTimeout(5000, () => process.exit(2));
socket.on("error", () => process.exit(3));
socket.on("connect", () => socket.write('{"operation":"checkCredentials","client":"codex"}\\n'));
socket.on("data", chunk => { data += chunk; if (data.includes("\\n")) { const reply = JSON.parse(data); socket.end(); process.exitCode = reply.admitted ? 0 : 4; } });
`,
      { mode: 0o644 },
    )
    await chmod(clientScript, 0o644)
    await command(asUid(controllerUid, [process.execPath, clientScript, socket]))
    await assert.rejects(command(asUid(agentUid, [process.execPath, clientScript, socket])))
    const worker = join(root, "worker.sh")
    await writeFile(
      worker,
      `#!/bin/sh
set -eu
id -u > "$1/uid"
if cat "$2" >/dev/null 2>&1; then exit 42; fi
printf denied > "$1/canary"
sleep 300 &
printf '%s' "$!" > "$1/descendant"
wait
`,
      { mode: 0o755 },
    )
    await chmod(worker, 0o755)
    // Neither the requester nor the admission server owns this service's lifetime.
    await command([
      "systemd-run",
      "--quiet",
      "--service-type=exec",
      `--unit=${unit}`,
      `--description=workflowd supervision ${nonce}`,
      `--property=User=${agentUid}`,
      `--property=Group=${groupGid}`,
      "--property=KillMode=control-group",
      "--property=NoNewPrivileges=yes",
      "--property=CapabilityBoundingSet=",
      "--property=PrivateDevices=yes",
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=yes",
      `--property=ReadWritePaths=${agentHome}`,
      "--property=RuntimeMaxSec=60",
      "--property=MemoryMax=256M",
      "--property=MemorySwapMax=0",
      "/bin/sh",
      worker,
      agentHome,
      canary,
    ])
    launched = true
    const deadline = Date.now() + 10000
    while (!(await readFile(join(agentHome, "descendant"), "utf8").catch(() => ""))) {
      assert(Date.now() < deadline, "supervision_worker_did_not_start")
      await delay(50)
    }
    const before = await inspect()
    assert.equal(before.ActiveState, "active")
    assert.equal(before.Description, `workflowd supervision ${nonce}`)
    assert.match(before.InvocationID, /^[a-f0-9]{32}$/)
    assert.equal(Number(await readFile(join(agentHome, "uid"), "utf8")), agentUid)
    const descendant = Number(await readFile(join(agentHome, "descendant"), "utf8"))
    assert(Number.isSafeInteger(descendant) && descendant > 1)
    const status = await readFile(`/proc/${descendant}/status`, "utf8")
    assert.equal(Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]), agentUid)
    assert.equal(await readFile(join(agentHome, "canary"), "utf8"), "denied")
    // Each requester has exited. Restart admission as well, then authenticate a
    // fresh controller and observe the same system-manager invocation.
    await host.close()
    host = undefined
    await rm(socket, { force: true })
    host = await serveCredentialHost(socket, policy)
    await command(asUid(controllerUid, [process.execPath, clientScript, socket]))
    const after = await inspect()
    assert.equal(after.InvocationID, before.InvocationID)
    assert.equal(after.MainPID, before.MainPID)
    assert.equal(after.ActiveState, "active")
    await command(["systemctl", "stop", unit])
    launched = false
    const stoppedBy = Date.now() + 3000
    for (const pid of [Number(before.MainPID), descendant]) {
      while (await readFile(`/proc/${pid}/status`, "utf8").catch(() => null)) {
        assert(Date.now() < stoppedBy, "supervision_process_survived_stop")
        await delay(25)
      }
    }
    return {
      uidCount: 2,
      peerAuthenticated: true,
      agentPeerDenied: true,
      descendantUidVerified: true,
      controllerFileDenied: true,
      sameInvocationAfterReconnect: true,
      descendantCancelled: true,
      status: "prerequisite-passed",
    }
  } finally {
    try {
      if (launched) await command(["systemctl", "stop", unit])
    } finally {
      await host?.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

if (process.argv.length === 3 && process.argv[2] === "--probe-opencode") {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "test",
        "test/agent-user/opencode-migration.e2e.test.ts",
        "--test-name-pattern",
        "^installed OpenCode",
      ],
      { stdio: "inherit" },
    )
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} else if (process.argv.length === 3 && process.argv[2] === "--probe-supervision") {
  try {
    console.log(JSON.stringify(await probeSupervision()))
  } catch (error) {
    // Diagnostics are bounded fixture-command errors; no model client is invoked.
    console.error(
      `Supervision probe blocked: ${error instanceof Error ? error.message : "unknown"}`,
    )
    process.exitCode = 2
  }
} else if (process.argv.length !== 3 || process.argv[2] !== "--probe-credentials") {
  console.error(
    "Usage: bun scripts/evidence/agent-user.mjs --probe-credentials|--probe-supervision|--probe-opencode",
  )
  process.exitCode = 2
} else {
  try {
    const evidence = await probeCodexCredentialSharing()
    const refresh = await probeInstalledRefresh()
    const compatible =
      evidence.directUpdateShared &&
      evidence.refusal === "shared_credential_diverged" &&
      evidence.repaired &&
      refresh.codex.refreshPersisted &&
      refresh.claude.refreshPersisted &&
      refresh.claude.repaired
    console.log(
      JSON.stringify({
        ...evidence,
        refresh,
        status: compatible ? "prerequisite-passed" : "blocked",
        crossUidRefreshVerified: refresh.uidCount === 2,
      }),
    )
    if (!compatible) process.exitCode = 1
  } catch {
    // Never forward client output, credentials or environment into evidence logs.
    console.error("Credential probe could not complete; provisioning remains blocked")
    process.exitCode = 2
  }
}
