import { randomUUID, createHash } from "node:crypto"
import { relinkCredentials } from "../../src/agent-host/credential-relink"
import {
  requestAgentHost,
  makeHostCli,
  startAgentHost,
  readAgentHostOutput,
  connectAgentHost,
  listAgentHost,
  acquireCredentialAdmission,
} from "../../src/agent-host/client"
import { RpcClient } from "../../src/resident/rpc"
import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect, createServer } from "node:net"
import { serveCredentialHost as serveHost } from "../../src/agent-host/server"

const identity = {
  WORKFLOWD_AGENT_GIT_NAME: "Fixture Agent",
  WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
  WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS: "blocked@example.test",
}
const serveCredentialHost = (...args: Parameters<typeof serveHost>) =>
  serveHost(args[0], args[1], args[2], identity)

// A controller cannot turn the credential service into a generic root launcher.
test("native host refuses unsupported profiles and unapproved agent groups", async () => {
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
  const policy = {
    root: store,
    ownerUid: uid,
    groupGid: gid,
    controllerUid: uid,
    agentUid: 65534,
    launch: {
      custodyRoot: root,
      ioRoot: root,
      home: root,
      workspaceRoot: root,
      bun: "/unused",
      worker: "/unused",
      codex: "/unused",
      claude: "/unused",
    },
    codex: { canonical, benLink, agentLink },
    claude: { canonical, benLink, agentLink },
    consumerExecutables: [],
  }
  let host = await serveCredentialHost(socketPath, policy)
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
            directory: root,
            prompt: "",
            model: null,
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
    const extra = await new Promise<string>((resolve, reject) => {
      const socket = connect(socketPath)
      socket.on("error", reject)
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({
            operation: "start",
            profile: "codex",
            runId: "extra-field",
            directory: root,
            prompt: "",
            model: null,
            user: 0,
          }) + "\n",
        ),
      )
      let text = ""
      socket.on("data", (chunk) => {
        text += chunk.toString()
        if (text.includes("\n")) {
          socket.destroy()
          resolve(text)
        }
      })
    })
    expect(JSON.parse(extra)).toEqual({ admitted: false, reason: "host_request_refused" })
    await host.close()
    await rm(socketPath, { force: true })
    const custodyRoot = join(root, "custody"),
      ioRoot = join(root, "io")
    await mkdir(custodyRoot, { mode: 0o700 })
    await mkdir(ioRoot, { mode: 0o711 })
    host = await serveCredentialHost(socketPath, {
      ...policy,
      agentUid: 65534,
      launch: {
        custodyRoot,
        ioRoot,
        home: root,
        workspaceRoot: root,
        bun: "/must-not-execute",
        worker: "/must-not-execute",
        codex: "/must-not-execute",
        claude: "/must-not-execute",
        repositories: [{ source: "/selector", remote: "/must-not-clone" }],
      },
    })
    await expect(
      requestAgentHost(socketPath, {
        operation: "start",
        profile: "workspace",
        runId: "unsafe-groups",
        directory: join(root, "clone"),
        repository: "/selector",
        branch: "work",
        prompt: "",
        model: null,
      }),
    ).rejects.toThrow("unsafe agent groups")
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { chown, readFile, realpath, copyFile, readdir, stat } from "node:fs/promises"
import { nativeModelFixture } from "../sandbox/native-fixture"
import { Effect, Schema } from "effect"
import type { ClaudeResumeJobV1 } from "../../src/remote/contract"
import { OwnedProcess, agentHostUnitName, type HostRequest } from "../../src/agent-host/protocol"

async function nativeBoundary(simulatedManager: boolean) {
  expect(process.getuid!()).toBe(0)
  const controllerUid = simulatedManager ? 0 : Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID)
  const agentUid = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID)
  const groupGid = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID)
  expect(controllerUid).not.toBe(agentUid)
  if (!simulatedManager) expect(process.env.WORKFLOWD_AGENT_DEPLOYED_TEST).toBe("1")
  const root = await mkdtemp(join(simulatedManager ? tmpdir() : "/var/lib", "native-services-"))
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
  const boundaryFiles = simulatedManager
    ? []
    : [
        `/tmp/workflowd-private-${randomUUID()}`,
        "/etc/workflowd/native-fixture-app-key",
        // Match controller stateRoot() and the deployed NATS/noscope layout.
        "/home/ben-fixture/.local/state/workflowd/workflowd.db",
        "/home/ben-fixture/.config/workflowd/env",
        "/home/ben-fixture/.config/nats/nats.conf",
        "/home/ben-fixture/.local/share/nats/nsc/keys/native-fixture.seed",
        "/home/ben-fixture/.config/noscope/providers/nats.toml",
        "/run/credentials/workflowd.service/nats-creds",
        "/home/ben-fixture/.ssh/native-fixture-key",
        "/home/ben-fixture/.config/gh/native-fixture-token",
      ]
  for (const path of boundaryFiles) {
    await mkdir((await import("node:path")).dirname(path), { recursive: true })
    await writeFile(path, "private-boundary-canary", { mode: 0o644, flag: "wx" })
  }
  const boundarySockets: Array<ReturnType<typeof createServer>> = []
  const createdSockets: string[] = []
  let dockerMode: number | undefined
  if (!simulatedManager) {
    const docker = await stat("/run/docker.sock")
    expect(docker.isSocket()).toBe(true)
    dockerMode = docker.mode & 0o777
    await chmod("/run/docker.sock", 0o666)
    // Prove the real Docker daemon and the file canaries are accessible to this
    // UID outside the unit, so DAC cannot make the isolation assertions vacuous.
    const probe = Bun.spawn(
      [
        "/usr/bin/setpriv",
        "--reuid",
        String(agentUid),
        "--regid",
        String(groupGid),
        "--clear-groups",
        "/usr/bin/python3",
        "-c",
        'import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect("/run/docker.sock"); s.sendall(b"GET /_ping HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n"); assert b"200 OK" in s.recv(4096); [open(p).read() for p in __import__("sys").argv[1:]]',
        ...boundaryFiles,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const diagnostic = await new Response(probe.stderr).text()
    expect({ status: await probe.exited, diagnostic }).toEqual({ status: 0, diagnostic: "" })
    for (const path of ["/run/tailscale/tailscaled.sock"]) {
      if (!(await stat(path).catch(() => null))) {
        await mkdir((await import("node:path")).dirname(path), { recursive: true })
        const socket = createServer((connection) => connection.end())
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject)
          socket.listen(path, resolve)
        })
        await chmod(path, 0o666)
        boundarySockets.push(socket)
        createdSockets.push(path)
      }
    }
  }
  const socketCommand = ["/run/docker.sock", "/run/tailscale/tailscaled.sock"]
    .map(
      (path) =>
        `if /usr/bin/python3 -c 'import socket; socket.socket(socket.AF_UNIX).connect("${path}")' 2>/dev/null; then echo exposed:${path}; else echo denied:${path}; fi`,
    )
    .join("; ")
  const boundaryCommand = boundaryFiles
    .map(
      (path) =>
        `if cat '${path}' >/dev/null 2>&1; then echo exposed:${path}; else echo denied:${path}; fi`,
    )
    .join("; ")
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
  // Every native invocation (including discovery, preflight, resume and resident)
  // must inherit the root host's configured identity under the agent UID.
  for (const fixture of [codex, claude]) {
    const script = await readFile(fixture.binary, "utf8")
    const newline = script.indexOf("\n") + 1
    const expected = {
      GIT_AUTHOR_NAME: "Fixture Agent",
      GIT_AUTHOR_EMAIL: "agent@example.test",
      GIT_COMMITTER_NAME: "Fixture Agent",
      GIT_COMMITTER_EMAIL: "agent@example.test",
    }
    await writeFile(
      fixture.binary,
      script.slice(0, newline) +
        `if (process.getuid() !== ${agentUid} || Object.entries(${JSON.stringify(expected)}).some(([key,value]) => process.env[key] !== value)) throw new Error("host identity propagation failed");\n` +
        script.slice(newline),
    )
  }
  const worker = join(root, "worker.js")
  const runtime = join(root, "bun")
  await copyFile(await realpath(process.execPath), runtime)
  await chmod(runtime, 0o755)
  const node = Bun.which("node")
  if (!node) throw new Error("native fixture Node runtime missing")
  await copyFile(await realpath(node), join(root, "node"))
  await chmod(join(root, "node"), 0o755)
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/kernel/codex-worker.ts")],
    target: "bun",
    minify: false,
  })
  expect(build.success).toBe(true)
  await writeFile(worker, await build.outputs[0]!.text(), { mode: 0o644 })
  const repository = join(root, "repository")
  const git = async (args: string[]) => {
    const child = Bun.spawn(["/usr/bin/git", ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) throw new Error(stderr)
  }
  await git(["init", "--initial-branch=main", repository])
  await git([
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ])
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
      bun: runtime,
      worker,
      codex: codex.binary,
      claude: claude.binary,
      repositories: [{ source: "/controller/repository-selector", remote: repository }],
    },
  }
  const path = simulatedManager ? join(root, "host.sock") : "/run/workflowd-agent-host/control.sock"
  const supervisor = simulatedManager ? fixtureSupervisor(agentUid, groupGid) : undefined
  const openHost = () =>
    simulatedManager ? serveCredentialHost(path, policy, supervisor) : deployedHost(root, policy)
  let host = await openHost()
  const units = new Set<string>()
  const call = async (
    request: HostRequest | { operation: "checkCredentials"; client: "codex" | "claude" },
    uid = controllerUid,
  ): Promise<unknown> => {
    if (simulatedManager && uid === controllerUid) {
      if (request.operation === "checkCredentials") {
        const release = await acquireCredentialAdmission(path, request.client)
        await release()
        return null
      }
      const value = await requestAgentHost(path, request)
      return Buffer.isBuffer(value) ? value.toJSON() : value
    }
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
        `import {requestAgentHost,acquireCredentialAdmission} from ${JSON.stringify(join(import.meta.dir, "../../src/agent-host/client.ts"))}; const request=JSON.parse(process.argv[2]); if(request.operation==="checkCredentials") {const release=await acquireCredentialAdmission(process.argv[1],request.client); await release(); console.log("null");} else console.log(JSON.stringify(await requestAgentHost(process.argv[1],request)));`,
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
  const repair = async (client: "codex" | "claude") => {
    const login = policy[client]
    const synthetic = await readFile(login.canonical)
    await rm(login.benLink)
    await writeFile(login.benLink, synthetic, { mode: 0o600 })
    await chown(login.benLink, controllerUid, groupGid)
    await relinkCredentials(policy, client, "ben").catch(async (error: unknown) => {
      const processes = []
      for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
        if ((await stat(`/proc/${pid}`).catch(() => null))?.uid !== agentUid) continue
        processes.push({
          pid,
          status: await readFile(`/proc/${pid}/status`, "utf8")
            .then((text) =>
              text.split("\n").filter((line) => /^(Name|State|PPid|NSpid):/.test(line)),
            )
            .catch(() => []),
        })
      }
      throw new Error(JSON.stringify({ error: String(error), processes }))
    })
  }
  const terminal = async (runId: string) => {
    const deadline = Date.now() + 45000
    for (;;) {
      const current = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "inspect", runId }),
      )
      if (!current.active) return current
      if (Date.now() > deadline) throw new Error("host process did not settle")
      await Bun.sleep(100)
    }
  }
  try {
    // Exercise automatic relink through the installed unit's real capability and
    // filesystem restrictions, with an authenticated controller-UID caller.
    for (const client of ["codex", "claude"] as const) {
      for (const side of ["ben", "agent"] as const) {
        const login = policy[client]
        const selected = side === "ben" ? login.benLink : login.agentLink
        const content = await readFile(login.canonical, "utf8")
        const { utimes } = await import("node:fs/promises")
        await utimes(login.canonical, 1, 1)
        await rm(selected)
        await writeFile(selected, content + "\n", { mode: 0o600 })
        await chown(selected, side === "ben" ? controllerUid : agentUid, groupGid)
        await call({ operation: "checkCredentials", client })
        const { lstat } = await import("node:fs/promises")
        expect((await lstat(login.benLink)).isSymbolicLink()).toBe(true)
        expect((await lstat(login.agentLink)).isSymbolicLink()).toBe(true)
        expect(await readFile(login.canonical, "utf8")).toBe(content + "\n")
      }
    }
    if (!simulatedManager) {
      const originalWorker = await readFile(worker)
      try {
        await writeFile(
          worker,
          `const input=await Bun.file(process.argv[process.argv.indexOf("--host-input")+1]).json(); const child=Bun.spawn(["/bin/sleep","120"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"}); await Bun.write(${JSON.stringify(workspaceRoot)}+"/"+input.runId, String(child.pid)); child.unref(); if(input.prompt!=="exit") await Bun.sleep(120000); process.exit(0);`,
        )
        for (const mode of ["stop", "exit", "timeout"]) {
          const runId = `orphan-${randomUUID()}`
          const owned = Schema.decodeUnknownSync(OwnedProcess)(
            await call({
              operation: "start",
              runId,
              profile: "codex-preflight",
              directory: "",
              prompt: mode,
              model: null,
              timeoutMs: 3000,
            }),
          )
          units.add(owned.unit)
          const until = Date.now() + 2000
          while (!(await stat(join(workspaceRoot, runId)).catch(() => null))) {
            if (Date.now() > until) throw new Error("descendant fixture did not start")
            await Bun.sleep(20)
          }
          const descendant = Number(await readFile(join(workspaceRoot, runId), "utf8"))
          if (mode !== "exit") expect((await stat(`/proc/${descendant}`)).uid).toBe(agentUid)
          if (mode === "stop") await call({ operation: "stop", runId, launchId: owned.launchId })
          const result = await terminal(runId)
          expect(result.active).toBe(false)
          expect(result.exitCode).toBe(mode === "exit" ? 0 : -1)
          if (mode === "timeout") expect(result.timedOut).toBe(true)
          const reaped = Date.now() + 5000
          while (await stat(`/proc/${descendant}`).catch(() => null)) {
            if (Date.now() > reaped) throw new Error("finished run retained its descendant")
            await Bun.sleep(50)
          }
          const check = Bun.spawn(
            ["systemctl", "show", owned.unit, "--property=LoadState", "--value"],
            { stdout: "pipe", stderr: "ignore" },
          )
          expect((await new Response(check.stdout).text()).trim()).toBe("not-found")
          await check.exited
        }
      } finally {
        await writeFile(worker, originalWorker)
      }
    }
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
      const preflightId = `preflight-${randomUUID()}`
      await call({
        operation: "start",
        runId: preflightId,
        profile: `${client}-preflight`,
        directory: "",
        prompt: "",
        model: null,
        timeoutMs: 10000,
      })
      expect((await terminal(preflightId)).exitCode).toBe(0)
      expect(fixture.requests.length).toBe(0)
      const extraProperty = { ...start, runId: `extra-${randomUUID()}`, user: 0 }
      await expect(call(extraProperty)).rejects.toThrow("host_request_refused")
      const unknownProfile = { ...start, runId: `unknown-${randomUUID()}` }
      Object.defineProperty(unknownProfile, "profile", { value: "root-shell" })
      await expect(call(unknownProfile)).rejects.toThrow("host_request_refused")
      for (const directory of ["/", `${workspaceRoot}/../controller`]) {
        await expect(
          call({ ...start, runId: `bad-directory-${randomUUID()}`, directory }),
        ).rejects.toThrow("host directory outside workspace policy")
      }
      const linked = join(workspaceRoot, `escape-${client}`)
      await symlink(controller, linked)
      await expect(
        call({ ...start, runId: `bad-link-${randomUUID()}`, directory: linked }),
      ).rejects.toThrow("host directory outside workspace policy")
      await rm(linked)
      const proof = join(workspaceRoot, `${client}-proof`)
      fixture.actions.push({
        name: client === "codex" ? "exec_command" : "Bash",
        arguments:
          client === "codex"
            ? {
                cmd: `id -u > '${proof}'; echo $$ > '${proof}-pid'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi; if ls '${custodyRoot}' >/dev/null 2>&1; then echo custody-exposed >> '${proof}'; else echo custody-denied >> '${proof}'; fi${simulatedManager ? "" : `; { ${boundaryCommand}; ${socketCommand}; if cat /proc/${globalThis.process.pid}/cmdline >/dev/null 2>&1; then echo proc-exposed; else echo proc-denied; fi; } > '${proof}-boundary'; sleep 300`}`,
                yield_time_ms: 1000,
              }
            : {
                command: `id -u > '${proof}'; echo $$ > '${proof}-pid'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi; if ls '${custodyRoot}' >/dev/null 2>&1; then echo custody-exposed >> '${proof}'; else echo custody-denied >> '${proof}'; fi${simulatedManager ? "" : `; { ${boundaryCommand}; ${socketCommand}; if cat /proc/${globalThis.process.pid}/cmdline >/dev/null 2>&1; then echo proc-exposed; else echo proc-denied; fi; } > '${proof}-boundary'; sleep 300`}`,
                timeout: 1000,
              },
      })
      fixture.holdAfter(1)
      const cli = simulatedManager
        ? makeHostCli(path, client, (line) => {
            Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(JSON.parse(line))
            return { type: "other" }
          })
        : undefined
      if (cli) {
        await Effect.runPromise(cli.preflight)
        await Effect.runPromise(
          cli.spawn({ runId, directory: workspaceRoot, prompt: start.prompt, model: start.model }),
        )
      }
      const process = Schema.decodeUnknownSync(OwnedProcess)(await call(start))
      units.add(process.unit)
      expect(process.uid).toBe(agentUid)
      const deadline = Date.now() + 45000
      while (!(await readFile(proof, "utf8").catch(() => "")).includes("custody-denied")) {
        if (Date.now() > deadline) {
          const io = join(ioRoot, createHash("sha256").update(runId).digest("hex"))
          throw new Error(
            JSON.stringify({
              client,
              requests: fixture.requests.length,
              process: await call({ operation: "inspect", runId }),
              stderr: await readFile(join(io, "stderr"), "utf8").catch(() => "missing"),
              events: await readFile(join(io, "events"), "utf8").catch(() => "missing"),
            }),
          )
        }
        await Bun.sleep(100)
      }
      expect(await readFile(proof, "utf8")).toBe(`${agentUid}\ndenied\ncustody-denied\n`)
      if (!simulatedManager) {
        const until = Date.now() + 5000
        while (!(await readFile(`${proof}-boundary`, "utf8").catch(() => "")).includes("proc-")) {
          if (Date.now() > until) throw new Error("boundary checks did not finish")
          await Bun.sleep(50)
        }
        const evidence = await readFile(`${proof}-boundary`, "utf8")
        for (const file of boundaryFiles) expect(evidence).toContain(`denied:${file}\n`)
        for (const path of ["/run/docker.sock", "/run/tailscale/tailscaled.sock"])
          expect(evidence).toContain(`denied:${path}\n`)
        expect(evidence).toContain("proc-denied\n")
        expect(evidence).not.toContain("exposed")
      }
      const descendant = Number((await readFile(`${proof}-pid`, "utf8")).trim())
      if (!simulatedManager) {
        expect(await readFile(`/proc/${descendant}/status`, "utf8")).toContain(
          `Uid:\t${agentUid}\t${agentUid}\t${agentUid}\t${agentUid}`,
        )
      }
      await host.close()
      await rm(path, { force: true })
      host = await openHost()
      const attached = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "inspect", runId }),
      )
      expect(attached.invocationId).toBe(process.invocationId)
      expect(attached.pid).toBe(process.pid)
      expect(attached.active).toBe(true)
      const custodyFile = join(
        custodyRoot,
        `${createHash("sha256").update(runId).digest("hex")}.json`,
      )
      const savedCustody = await readFile(custodyFile, "utf8")
      const savedRecord = JSON.parse(savedCustody)
      try {
        await writeFile(
          custodyFile,
          JSON.stringify({ ...savedRecord, process: { ...savedRecord.process, uid: 0 } }),
        )
        await expect(call({ operation: "inspect", runId })).rejects.toThrow("forged host custody")
        await writeFile(
          custodyFile,
          JSON.stringify({
            ...savedRecord,
            process: { ...savedRecord.process, invocationId: "foreign" },
          }),
        )
        await expect(call({ operation: "inspect", runId })).rejects.toThrow(
          "host invocation identity mismatch",
        )
      } finally {
        await writeFile(custodyFile, savedCustody)
      }
      await expect(call({ ...start, prompt: "conflicting launch" })).rejects.toThrow(
        "host launch identity conflict",
      )
      await expect(
        call({ operation: "stop", runId: `missing-${randomUUID()}`, launchId: "missing" }),
      ).rejects.toThrow("host custody missing")
      expect(Schema.decodeUnknownSync(OwnedProcess)(await call(start)).invocationId).toBe(
        process.invocationId,
      )
      await expect(call({ operation: "stop", runId, launchId: "forged" })).rejects.toThrow(
        "host_request_refused",
      )
      await chmod(path, 0o666)
      try {
        for (const request of [
          start,
          { operation: "inspect", runId },
          { operation: "stop", runId, launchId: process.launchId },
          { operation: "listOwned", cursor: 0 },
          { operation: "exchange", runId, launchId: process.launchId, file: "events", offset: 0 },
          { operation: "connect", runId, launchId: process.launchId },
        ] satisfies HostRequest[]) {
          for (const uid of simulatedManager ? [agentUid] : [agentUid, 0])
            await expect(call(request, uid)).rejects.toThrow(
              "shared_credential_permissions_invalid",
            )
        }
        await expect(
          call({ operation: "checkCredentials", client: "codex" }, agentUid),
        ).rejects.toThrow("shared_credential_permissions_invalid")
      } finally {
        await chmod(path, 0o600)
      }
      if (cli?.ownership === "transient-exec") {
        const attached = await Effect.runPromise(cli.attach({ runId }))
        if (!attached) throw new Error("native adapter lost host custody")
        await Effect.runPromise(attached.cancel)
        const events = []
        for await (const event of attached.events) events.push(event)
        expect(events.length).toBeGreaterThan(0)
        expect((await Effect.runPromise(attached.exited)).exitCode).toBe(-1)
      }
      const stopped = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "stop", runId, launchId: process.launchId }),
      )
      expect(stopped.active).toBe(false)
      expect(await readFile(`/proc/${process.pid}/status`, "utf8").catch(() => null)).toBeNull()
      if (!simulatedManager) {
        const deadline = Date.now() + 5000
        while (await stat(`/proc/${descendant}`).catch(() => null)) {
          if (Date.now() > deadline) throw new Error("cancelled descendant was not reaped")
          await Bun.sleep(50)
        }
      }
      const output = join(ioRoot, createHash("sha256").update(runId).digest("hex"), "events")
      await rm(output)
      await symlink(canary, output)
      await expect(
        call({
          operation: "exchange",
          runId,
          launchId: process.launchId,
          file: "events",
          offset: 0,
        }),
      ).rejects.toThrow("host_request_refused")
      await rm(output)
      await writeFile(output, "x".repeat(100000), { mode: 0o600 })
      await chown(output, agentUid, groupGid)
      const chunk = await call({
        operation: "exchange",
        runId,
        launchId: process.launchId,
        file: "events",
        offset: 0,
      })
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Schema.Number) }))(chunk).data
          .length,
      ).toBe(65536)
      const priorCount = fixture.requests.length
      await rm(policy[client].agentLink)
      await expect(call({ ...start, runId: `${runId}-broken` })).rejects.toThrow(
        "shared_credential_link_broken",
      )
      expect(fixture.requests.length).toBe(priorCount)
      await repair(client)
      if (!simulatedManager) {
        fixture.release()
        fixture.holdAfter(Infinity)
        const prompt = `admission-${client}-${randomUUID()}`
        const input = {
          runId: `admission-${randomUUID()}`,
          directory: workspaceRoot,
          prompt,
          model: start.model,
        }
        const controllerCli = async (operation: "preflight" | "spawn") => {
          const program = `import {Effect} from ${JSON.stringify(join(import.meta.dir, "../../node_modules/effect/dist/index.js"))};
import {makeHostCli} from ${JSON.stringify(join(import.meta.dir, "../../src/agent-host/client.ts"))};
const cli=makeHostCli(${JSON.stringify(path)},${JSON.stringify(client)},()=>({type:"other"}));
${operation === "preflight" ? "await Effect.runPromise(cli.preflight)" : `const run=await Effect.runPromise(cli.spawn(${JSON.stringify(input)})); const result=await Effect.runPromise(run.exited); if(result.exitCode!==0) throw new Error(JSON.stringify(result));`}`
          const child = Bun.spawn(
            [
              "/usr/bin/setpriv",
              "--reuid",
              String(controllerUid),
              "--regid",
              String(groupGid),
              "--clear-groups",
              globalThis.process.execPath,
              "--eval",
              program,
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
          const stderr = await new Response(child.stderr).text()
          if ((await child.exited) !== 0) throw new Error(stderr)
        }
        await controllerCli("preflight")
        await rm(policy[client].agentLink)
        await expect(controllerCli("spawn")).rejects.toThrow("shared_credential_link_broken")
        expect(
          fixture.requests.filter((request) => JSON.stringify(request).includes(prompt)),
        ).toHaveLength(0)
        await repair(client)
        await controllerCli("spawn")
        expect(
          fixture.requests.filter((request) => JSON.stringify(request).includes(prompt)),
        ).toHaveLength(1)
      }
    }
    const discoveryId = `discovery-${randomUUID()}`
    await call({
      operation: "start",
      profile: "codex-discovery",
      runId: discoveryId,
      directory: "",
      prompt: "",
      model: null,
      timeoutMs: 30000,
    })
    expect((await terminal(discoveryId)).exitCode).toBe(0)
    if (simulatedManager) {
      const discovered = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "inspect", runId: discoveryId }),
      )
      expect(Array.isArray(JSON.parse(await readAgentHostOutput(path, discovered)))).toBe(true)
    }
    {
      const input = {
        operation: "start" as const,
        profile: "workspace" as const,
        runId: `workspace-${randomUUID()}`,
        repository: "/controller/repository-selector",
        directory: join(workspaceRoot, "clone"),
        branch: "agent-work",
        prompt: "",
        model: null,
      }
      const workspace = Schema.decodeUnknownSync(OwnedProcess)(await call(input))
      expect((await terminal(input.runId)).exitCode).toBe(0)
      expect(Schema.decodeUnknownSync(OwnedProcess)(await call(input)).invocationId).toBe(
        workspace.invocationId,
      )
      expect((await stat(join(input.directory, ".git"))).uid).toBe(agentUid)
      const hooks = join(input.directory, ".git", "workflowd-hooks")
      for (const [name, mode] of [
        ["agent-worktree", 0o600],
        ["blocked-emails", 0o600],
        ["identity-guard", 0o700],
      ] as const) {
        const info = await stat(join(hooks, name))
        expect(info.uid).toBe(agentUid)
        expect(info.mode & 0o777).toBe(mode)
      }
      const probe = Bun.spawn(
        [
          "/usr/bin/setpriv",
          "--reuid",
          String(agentUid),
          "--regid",
          String(groupGid),
          "--clear-groups",
          runtime,
          "--eval",
          `
        const cwd = process.argv[1];
        const run = async (args, env = {}) => {
          const child = Bun.spawn(["git", "-C", cwd, ...args], {env: {...process.env, ...env}, stdout:"pipe", stderr:"pipe"});
          const output = await new Response(child.stderr).text();
          return {code: await child.exited, blocked: output.includes("workflowd: blocked git identity")};
        };
        const blocked = await run(["commit", "--allow-empty", "--author=Blocked <blocked@example.test>", "-m", "blocked"]);
        const committer = await run(["commit", "--allow-empty", "-m", "blocked"], {GIT_COMMITTER_EMAIL:"blocked@example.test"});
        const allowed = await run(["commit", "--allow-empty", "-m", "allowed"]);
        console.log(JSON.stringify({blocked, committer, allowed}));
      `,
          input.directory,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: home,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Fixture Agent",
            GIT_AUTHOR_EMAIL: "agent@example.test",
            GIT_COMMITTER_NAME: "Fixture Agent",
            GIT_COMMITTER_EMAIL: "agent@example.test",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const proof = await new Response(probe.stdout).text()
      expect(await new Response(probe.stderr).text()).toBe("")
      expect(await probe.exited).toBe(0)
      expect(JSON.parse(proof)).toEqual({
        blocked: { code: 1, blocked: true },
        committer: { code: 1, blocked: true },
        allowed: { code: 0, blocked: false },
      })

      expect(await readFile(join(input.directory, ".git", "HEAD"), "utf8")).toBe(
        "ref: refs/heads/agent-work\n",
      )
      expect(await readFile(join(repository, ".git", "HEAD"), "utf8")).toBe(
        "ref: refs/heads/main\n",
      )
    }
    claude.release()
    claude.holdAfter(Infinity)
    claude.reply('{"acknowledged":true,"summary":"host resumed"}')
    const seedId = `agent-run-claude-seed-${randomUUID()}`
    const seed = Schema.decodeUnknownSync(OwnedProcess)(
      await call({
        operation: "start",
        runId: seedId,
        profile: "claude",
        directory: workspaceRoot,
        prompt: "Seed the resume fixture.",
        model: "claude-opus-4-6",
      }),
    )
    units.add(seed.unit)
    const seedDeadline = Date.now() + 30000
    while (
      Schema.decodeUnknownSync(OwnedProcess)(await call({ operation: "inspect", runId: seedId }))
        .active
    ) {
      if (Date.now() > seedDeadline) throw new Error("Claude seed did not complete")
      await Bun.sleep(100)
    }
    const events = (
      await readFile(
        join(ioRoot, createHash("sha256").update(seedId).digest("hex"), "events"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) =>
        Schema.decodeUnknownSync(
          Schema.Struct({ type: Schema.String, session_id: Schema.optionalKey(Schema.String) }),
        )(JSON.parse(line)),
      )
    const nativeSessionId = events.find((event) => event.type === "system")?.session_id
    if (!nativeSessionId) throw new Error("Claude native transcript was not created")
    const payload: ClaudeResumeJobV1 = {
      kind: "claude_resume",
      hostId: "fixture",
      nativeSessionId,
      directory: workspaceRoot,
      prompt: "Resume exactly once.",
      extractionSchemaJson: '{"type":"object"}',
      turnTimeoutMs: 60000,
    }
    // Transcript preflight succeeds, then a broken link must block the actual resume.
    const probeId = `session-${randomUUID()}`
    await call({
      operation: "start",
      runId: probeId,
      profile: "claude-session",
      directory: workspaceRoot,
      nativeSessionId,
      prompt: "",
      model: null,
    })
    expect((await terminal(probeId)).exitCode).toBe(0)
    const beforeRefusal = claude.requests.length
    await rm(policy.claude.agentLink)
    await expect(
      call({
        operation: "start",
        profile: "claude-resume",
        runId: `refused-${randomUUID()}`,
        directory: workspaceRoot,
        nativeSessionId,
        prompt: "refused",
        model: null,
      }),
    ).rejects.toThrow("shared_credential_link_broken")
    expect(claude.requests.length).toBe(beforeRefusal)
    await repair("claude")
    const deliveryId = `native-recovery-${randomUUID()}`
    const baseline = claude.requests.length
    const resumeProgram = (recover: boolean) => `
import { Effect } from ${JSON.stringify(join(import.meta.dir, "../../node_modules/effect/dist/index.js"))};
import { makeClaudeCli } from ${JSON.stringify(join(import.meta.dir, "../../src/kernel/claude-session.ts"))};
import { makeClaudeResumeExecutor } from ${JSON.stringify(join(import.meta.dir, "../../src/remote/claude-resume-executor.ts"))};
const executor = makeClaudeResumeExecutor({cli:makeClaudeCli({binary:"unused",credentialSocket:${JSON.stringify(path)}}),allowedDirectories:[${JSON.stringify(workspaceRoot)}]});
console.log(JSON.stringify(await Effect.runPromise(executor.${recover ? "recover" : "execute"}(${JSON.stringify(payload)},${JSON.stringify(deliveryId)}))));`
    if (!simulatedManager) {
      claude.holdAfter(baseline)
      const firstController = Bun.spawn(
        [
          "/usr/bin/setpriv",
          "--reuid",
          String(controllerUid),
          "--regid",
          String(groupGid),
          "--clear-groups",
          process.execPath,
          "--eval",
          resumeProgram(false),
        ],
        { stdout: "ignore", stderr: "inherit" },
      )
      const deadline = Date.now() + 30000
      while (claude.requests.length === baseline) {
        if (firstController.exitCode !== null || Date.now() > deadline)
          throw new Error("controller did not deliver Claude wake")
        await Bun.sleep(100)
      }
      firstController.kill("SIGKILL")
      await firstController.exited
      await host.close()
      await rm(path, { force: true })
      host = await openHost()
      claude.release()
      claude.holdAfter(Infinity)
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = Bun.spawn(
          [
            "/usr/bin/setpriv",
            "--reuid",
            String(controllerUid),
            "--regid",
            String(groupGid),
            "--clear-groups",
            process.execPath,
            "--eval",
            resumeProgram(true),
          ],
          { stdout: "pipe", stderr: "inherit" },
        )
        const answer: unknown = JSON.parse(await new Response(controller.stdout).text())
        expect(await controller.exited).toBe(0)
        expect(answer).toEqual({
          status: "succeeded",
          output: '{"acknowledged":true,"summary":"host resumed"}',
        })
      }
    } else {
      for (const recover of [false, true]) {
        const controller = Bun.spawn([process.execPath, "--eval", resumeProgram(recover)], {
          stdout: "pipe",
          stderr: "inherit",
        })
        const answer: unknown = JSON.parse(await new Response(controller.stdout).text())
        expect(await controller.exited).toBe(0)
        expect(answer).toEqual({
          status: "succeeded",
          output: '{"acknowledged":true,"summary":"host resumed"}',
        })
      }
    }
    expect(claude.requests.length - baseline).toBe(2)
    if (simulatedManager) {
      const owned = await startAgentHost(path, {
        runId: `resident-${randomUUID()}`,
        profile: "codex-server",
        directory: "",
        prompt: "",
        model: null,
      })
      const attach = async () => {
        const rpc = new RpcClient(
          (line) => transport.send(line),
          () => {},
        )
        const transport = await connectAgentHost(
          path,
          owned,
          (line) => rpc.receive(line),
          () => rpc.close(),
        )
        await rpc.request("initialize", {
          clientInfo: { name: "fixture", version: "1" },
          capabilities: { experimentalApi: true },
        })
        transport.send(JSON.stringify({ method: "initialized" }))
        return {
          rpc,
          close: () => {
            rpc.close()
            transport.close()
          },
        }
      }
      const first = await attach()
      expect(await first.rpc.request("thread/list", { limit: 1 })).toHaveProperty("data")
      first.close()
      const attached = await attach()
      expect(
        Schema.decodeUnknownSync(OwnedProcess)(
          await call({ operation: "inspect", runId: owned.runId }),
        ).pid,
      ).toBe(owned.pid)
      const count = codex.requests.length
      await rm(policy.codex.agentLink)
      await expect(
        attached.rpc.request("thread/start", { cwd: workspaceRoot }),
      ).rejects.toMatchObject({ reason: "shared_credential_link_broken" })
      await expect(
        attached.rpc.request("review/start", { threadId: "fixture" }),
      ).rejects.toMatchObject({ reason: "shared_credential_link_broken" })
      await expect(attached.rpc.request("unknown/start", {})).rejects.toMatchObject({
        code: -32601,
      })
      expect(codex.requests.length).toBe(count)
      attached.close()
      expect((await listAgentHost(path)).map((process) => process.unit)).toContain(owned.unit)
      await requestAgentHost(path, {
        operation: "stop",
        runId: owned.runId,
        launchId: owned.launchId,
      })
      expect((await terminal(owned.runId)).active).toBe(false)
      await repair("codex")
    } else {
      const launchId = randomUUID()
      const runId = `agent-run-resident-${randomUUID()}`
      const hostId = `${runId}-${launchId}`
      const controllerProgram = async (reattach: boolean) => {
        const owned = reattach
          ? Schema.decodeUnknownSync(OwnedProcess)(
              await call({ operation: "inspect", runId: hostId }),
            )
          : null
        const program = `import {launchAppServer,attachAppServer} from ${JSON.stringify(join(import.meta.dir, "../../src/resident/process.ts"))};
const server = await ${reattach ? `attachAppServer(${JSON.stringify({ socket: hostId, unit: owned!.unit, launchId, invocation: owned!.invocationId, hostSocket: path })},()=>{})` : `launchAppServer(${JSON.stringify({ binary: "unused", home: "/unreadable-home", hostSocket: path, runId, launchId })},()=>{})`};
await server.initialize(); await server.rpc.request("thread/list",{limit:1}); console.log(JSON.stringify({pid:server.pid,invocation:server.invocation})); await server.detach();`
        const child = Bun.spawn(
          [
            "/usr/bin/setpriv",
            "--reuid",
            String(controllerUid),
            "--regid",
            String(groupGid),
            "--clear-groups",
            process.execPath,
            "--eval",
            program,
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (status !== 0) throw new Error(stderr)
        return JSON.parse(stdout) as unknown
      }
      const first = await controllerProgram(false)
      await host.close()
      await rm(path, { force: true })
      host = await openHost()
      expect(await controllerProgram(true)).toEqual(first)
      const owned = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "inspect", runId: hostId }),
      )
      expect(owned.uid).toBe(agentUid)
      await call({ operation: "stop", runId: hostId, launchId })
      expect((await terminal(hostId)).active).toBe(false)
      const recordName = (await readdir(custodyRoot)).find((name) => name.endsWith(".json"))!
      const recordPath = join(custodyRoot, recordName)
      const old = new Date(Date.now() - 8 * 86400000)
      await (await import("node:fs/promises")).utimes(recordPath, old, old)
      await host.close()
      host = await openHost()
      const collected = Date.now() + 5000
      while (await stat(recordPath).catch(() => null)) {
        if (Date.now() > collected) throw new Error("deployed host did not collect expired custody")
        await Bun.sleep(50)
      }
      expect(await stat(join(ioRoot, recordName.slice(0, -5))).catch(() => null)).toBeNull()
    }
  } finally {
    for (const name of await readdir(custodyRoot)) {
      if (!name.endsWith(".json")) continue
      const record = Schema.decodeUnknownSync(Schema.Struct({ process: OwnedProcess }))(
        JSON.parse(await readFile(join(custodyRoot, name), "utf8")),
      )
      units.add(record.process.unit)
    }
    for (const unit of units) {
      if (supervisor) {
        await supervisor(["/usr/bin/systemctl", "stop", unit])
        continue
      }
      await Bun.spawn(["systemctl", "stop", unit], { stdout: "ignore", stderr: "ignore" }).exited
      await Bun.spawn(["systemctl", "reset-failed", unit], { stdout: "ignore", stderr: "ignore" })
        .exited
    }
    await host.close()
    if (!simulatedManager) {
      if (dockerMode !== undefined) await chmod("/run/docker.sock", dockerMode)
      for (const socket of boundarySockets)
        await new Promise<void>((resolve) => socket.close(() => resolve()))
      for (const path of createdSockets) await rm(path, { force: true })
      for (const path of boundaryFiles) await rm(path, { force: true })
      for (const path of [
        "/etc/workflowd/agent-host.json",
        "/etc/workflowd/agent-git.env",
        "/etc/systemd/system/workflowd-agent-host.service",
        "/etc/systemd/system/workflowd-agent-host.service.d/fixture.conf",
        "/usr/local/libexec/workflowd-agent-host",
      ])
        await rm(path, { force: true })
      expect(await Bun.spawn(["systemctl", "daemon-reload"]).exited).toBe(0)
    }
    await codex.close()
    await claude.close()
    await rm(root, { recursive: true, force: true })
  }
}

test("native CI requires both real fixture identities and the deployed service gate", () => {
  if (process.env.WORKFLOWD_AGENT_DEPLOYED_TEST !== "1") return
  expect(process.getuid!()).toBe(0)
  expect(process.env.WORKFLOWD_AGENT_TEST_BEN_UID).toBe("61001")
  expect(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID).toBe("61002")
  expect(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID).toBe("61000")
})

if (process.env.WORKFLOWD_AGENT_TEST_BEN_UID) {
  test(
    "two-UID native services retain custody across controller restart and refuse forged launches",
    () => nativeBoundary(false),
    150000,
  )
  test(
    "the host native protocol uses bounded custody with a simulated manager and real UID children",
    () => nativeBoundary(true),
    150000,
  )
}

function fixtureSupervisor(agentUid: number, groupGid: number) {
  const units = new Map<
    string,
    {
      child: ReturnType<typeof Bun.spawn>
      description: string
      invocation: string
      stopped: boolean
    }
  >()
  return async (args: string[]) => {
    if (args[0] === "/usr/bin/systemd-run") {
      const value = (prefix: string) =>
        args.find((arg) => arg.startsWith(prefix))!.slice(prefix.length)
      const unit = value("--unit=")
      const at = args.findIndex((arg, index) => index > 0 && !arg.startsWith("--"))
      const env = Object.fromEntries(
        args
          .filter((arg) => arg.startsWith("--setenv="))
          .map((arg) => {
            const value = arg.slice(9)
            const at = value.indexOf("=")
            return [value.slice(0, at), value.slice(at + 1)]
          }),
      )
      const binding = args
        .find((arg) => arg.startsWith("--property=BindPaths="))
        ?.slice("--property=BindPaths=".length)
        .split(":")
      const child = Bun.spawn(
        [
          // A private PID namespace makes the simulated manager's stop kill
          // descendants that create their own process groups, like a real cgroup.
          "/usr/bin/unshare",
          "--pid",
          "--fork",
          "--kill-child",
          "--mount-proc",
          ...(binding
            ? [
                "/bin/sh",
                "-c",
                'mount --make-rprivate /; mkdir -p "$1"; mount --bind "$2" "$1"; shift 2; exec "$@"',
                "fixture",
                binding[1]!,
                binding[0]!,
              ]
            : []),
          "/usr/bin/setpriv",
          "--reuid",
          String(agentUid),
          "--regid",
          String(groupGid),
          "--clear-groups",
          ...args.slice(at),
        ],
        {
          cwd: value("--working-directory="),
          env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          detached: true,
        },
      )
      units.set(unit, {
        child,
        description: value("--description="),
        invocation: randomUUID().replaceAll("-", ""),
        stopped: false,
      })
      return ""
    }
    const unit = args.find((value) => value.endsWith(".service"))!
    const state = units.get(unit)
    if (!state) return "LoadState=not-found\n"
    if (args.includes("stop")) {
      if (state.child.exitCode === null) {
        // Keep unshare alive to wait for namespace teardown before acknowledging stop.
        const children = await readFile(
          `/proc/${state.child.pid}/task/${state.child.pid}/children`,
          "utf8",
        ).catch(() => "")
        for (const pid of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
          try {
            process.kill(pid, "SIGKILL")
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
          }
        }
      }
      await state.child.exited
      // In administrative coverage Bun is PID 1 and owns exited CLI helpers.
      // Reap them before the production relink check verifies a drained agent UID.
      if (process.pid === 1) {
        const { dlopen, FFIType, ptr } = await import("bun:ffi")
        const libc = dlopen("libc.so.6", {
          waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        })
        try {
          const status = new Int32Array(1)
          while (libc.symbols.waitpid(-1, ptr(status), 1) > 0) {
            /* reap exited orphans */
          }
        } finally {
          libc.close()
        }
      }
      state.stopped = true
      return ""
    }
    return `LoadState=loaded\nActiveState=${state.stopped ? "inactive" : "active"}\nSubState=${state.child.exitCode === null ? "running" : "exited"}\nMainPID=${state.child.exitCode === null ? state.child.pid : 0}\nInvocationID=${state.invocation}\nDescription=${state.description}\nUser=${agentUid}\nExecMainCode=1\nExecMainStatus=${state.child.exitCode ?? 0}\n`
  }
}

test("controller discovery and workspace adapters use host custody without local filesystem access", async () => {
  const { makeCodexDiscovery } = await import("../../src/execution/codex")
  const { agentRunWorktrees } = await import("../../src/kernel/agent-run-worktrees")
  const { makeClaudeCli } = await import("../../src/kernel/claude-session")
  const { createServer } = await import("node:net")
  const { HostRequest, agentHostUnitName } = await import("../../src/agent-host/protocol")
  const root = await mkdtemp(join(tmpdir(), "host-controller-"))
  const socket = join(root, "host.sock")
  let owned: typeof OwnedProcess.Type | null = null
  let output: unknown = [
    {
      provider: "fixture",
      model: "native-model",
      selectionModel: "picker",
      name: "Native",
      efforts: [{ id: "high", description: "High" }],
      defaultEffort: "high",
      defaultModel: true,
      modalities: { input: ["text"] },
      availability: "unknown",
    },
  ]
  let exitCode = 0
  const starts: Array<Extract<typeof HostRequest.Type, { operation: "start" }>> = []
  const stops: string[] = []
  const host = createServer((connection) => {
    let text = ""
    connection.on("error", () => connection.destroy())
    connection.on("data", (chunk) => {
      text += chunk.toString()
      if (!text.includes("\n")) return
      const request = Schema.decodeUnknownSync(HostRequest)(JSON.parse(text))
      if (request.operation === "start") {
        starts.push(request)
        owned = {
          runId: request.runId,
          launchId: randomUUID(),
          unit: agentHostUnitName(request.runId),
          invocationId: "fixture-invocation",
          uid: 12345,
          pid: 0,
          started: new Date().toISOString(),
          active: false,
          exitCode,
        }
      }
      if (request.operation === "stop") stops.push(request.runId)
      connection.end(
        JSON.stringify(
          request.operation === "exchange"
            ? {
                admitted: true,
                bytes: Buffer.from(JSON.stringify(output))
                  .subarray(request.offset)
                  .toString("base64"),
              }
            : {
                admitted: true,
                process:
                  request.operation === "inspect" && request.runId !== owned?.runId ? null : owned,
              },
        ) + "\n",
      )
    })
  })
  await new Promise<void>((resolve) => host.listen(socket, resolve))
  try {
    const discovery = makeCodexDiscovery("codex:local", {
      command: ["must-not-execute"],
      credentialSocket: socket,
    })
    expect<unknown>(await discovery.discover(AbortSignal.timeout(1000))).toEqual(output)
    expect(stops).toEqual([starts[0]!.runId])
    output = { status: "unsupported" }
    expect<unknown>(await discovery.discover(AbortSignal.timeout(1000))).toEqual(output)
    output = { unsafe: "not-a-catalog" }
    await expect(discovery.discover(AbortSignal.timeout(1000))).rejects.toThrow()
    expect(stops).toHaveLength(3)
    const count = starts.length
    await expect(discovery.discover(AbortSignal.abort())).rejects.toThrow()
    expect(starts).toHaveLength(count)
    const input = {
      repository: "/controller/selector",
      directory: "/inaccessible/agent/run",
      branch: "work",
      base: "origin/main",
    }
    output = ""
    await Effect.runPromise(agentRunWorktrees(socket).create(input))
    await Effect.runPromise(agentRunWorktrees(socket).create(input))
    expect(starts.at(-1)).toMatchObject({ ...input, profile: "workspace" })
    expect(starts.at(-1)?.runId).not.toBe(starts.at(-2)?.runId)
    exitCode = 1
    const failed = await Effect.runPromise(
      agentRunWorktrees(socket).create(input).pipe(Effect.result),
    )
    expect(failed._tag).toBe("Failure")
    exitCode = 0
    const cli = makeClaudeCli({ binary: "must-not-execute", credentialSocket: socket })
    output = true
    expect(
      await Effect.runPromise(
        cli.sessionExists({
          nativeSessionId: "native-session",
          directory: "/inaccessible/agent/run",
        }),
      ),
    ).toBe(true)
    expect(
      await Effect.runPromise(
        cli.sessionExists({ nativeSessionId: "../invalid", directory: "/inaccessible/agent/run" }),
      ),
    ).toBe(false)
    output = { result: "resumed" }
    expect(
      JSON.parse(
        await Effect.runPromise(
          cli.resume({
            nativeSessionId: "native-session",
            directory: "/inaccessible/agent/run",
            prompt: "resume",
            deliveryId: "stable-delivery",
            timeoutMs: 1000,
          }),
        ),
      ),
    ).toEqual(output)
    expect(await Effect.runPromise(cli.hasDelivery!("stable-delivery"))).toBe(true)
    expect(await Effect.runPromise(cli.hasDelivery!("unknown-delivery"))).toBe(false)
    expect(starts.at(-1)).toMatchObject({
      profile: "claude-resume",
      nativeSessionId: "native-session",
      timeoutMs: 1000,
    })
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test("the host persists terminal status before unloading the cgroup and inspects other runs concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-lifecycle-"))
  const uid = process.getuid!()
  const custodyRoot = join(root, "custody")
  const ioRoot = join(root, "io")
  await mkdir(custodyRoot, { mode: 0o700 })
  await mkdir(ioRoot, { mode: 0o700 })
  const login = { canonical: "/unused", benLink: "/unused", agentLink: "/unused" }
  const policy = {
    root,
    ownerUid: uid,
    controllerUid: uid,
    agentUid: 61002,
    groupGid: process.getgid!(),
    codex: login,
    claude: login,
    consumerExecutables: [],
    launch: {
      retentionMs: 1000,
      custodyRoot,
      ioRoot,
      home: root,
      workspaceRoot: root,
      bun: "/unused",
      worker: "/unused",
      codex: "/unused",
      claude: "/unused",
    },
  }
  const records = new Map<string, { unit: string; launchId: string }>()
  for (const runId of ["slow", "finished", "failed", "mismatch"]) {
    const key = createHash("sha256").update(runId).digest("hex")
    const unit = agentHostUnitName(runId)
    const launchId = randomUUID()
    records.set(runId, { unit, launchId })
    await writeFile(
      join(custodyRoot, `${key}.json`),
      JSON.stringify({
        request: {
          operation: "start",
          runId,
          profile: "codex",
          directory: root,
          prompt: "",
          model: null,
        },
        process: {
          runId,
          unit,
          launchId,
          invocationId: "fixture",
          uid: 61002,
          pid: 123,
          started: new Date().toISOString(),
          active: true,
          exitCode: null,
        },
        digest: "fixture",
        cancelled: false,
      }),
    )
  }
  let releaseSlow!: () => void
  let enteredSlow!: () => void
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enteredSlow = resolve
  })
  const stopped = new Set<string>()
  const path = join(root, "host.sock")
  const host = await serveCredentialHost(path, policy, async (args) => {
    const [runId, record] = [...records].find(([, record]) => args.includes(record.unit))!
    if (args.includes("stop")) {
      stopped.add(runId)
      return ""
    }
    if (stopped.has(runId)) return "LoadState=not-found\n"
    if (runId === "slow") {
      enteredSlow()
      await slow
    }
    return `LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\nInvocationID=fixture\nDescription=workflowd native ${runId === "mismatch" ? "foreign" : record.launchId}\nUser=61002\nExecMainCode=1\nExecMainStatus=${runId === "failed" ? 7 : 0}\n`
  })
  try {
    const pending = requestAgentHost(path, { operation: "inspect", runId: "slow" })
    await entered
    const completed = await Promise.race([
      requestAgentHost(path, { operation: "inspect", runId: "finished" }),
      Bun.sleep(500).then(() => "blocked by another run"),
    ])
    releaseSlow()
    await pending
    expect(completed).toMatchObject({ active: false, exitCode: 0 })
    expect(stopped.has("finished")).toBe(true)
    expect(await requestAgentHost(path, { operation: "inspect", runId: "finished" })).toMatchObject(
      { exitCode: 0 },
    )
    expect(await requestAgentHost(path, { operation: "inspect", runId: "failed" })).toMatchObject({
      exitCode: 7,
    })
    expect(await requestAgentHost(path, { operation: "inspect", runId: "failed" })).toMatchObject({
      exitCode: 7,
    })
    await expect(
      requestAgentHost(path, { operation: "inspect", runId: "mismatch" }),
    ).rejects.toThrow("host invocation identity mismatch")
    await expect(
      requestAgentHost(path, { operation: "stop", runId: "missing", launchId: "none" }),
    ).rejects.toThrow("host custody missing")
    await expect(
      requestAgentHost(path, { operation: "stop", runId: "failed", launchId: "forged" }),
    ).rejects.toThrow("forged host launch nonce")
    const forgedPath = join(
      custodyRoot,
      `${createHash("sha256").update("failed").digest("hex")}.json`,
    )
    const original = JSON.parse(await readFile(forgedPath, "utf8"))
    await writeFile(
      forgedPath,
      JSON.stringify({ ...original, process: { ...original.process, uid: 0 } }),
    )
    await expect(requestAgentHost(path, { operation: "inspect", runId: "failed" })).rejects.toThrow(
      "forged host custody",
    )
    await writeFile(forgedPath, JSON.stringify(original))
    await expect(
      requestAgentHost(path, {
        operation: "start",
        runId: "failed",
        profile: "codex",
        directory: root,
        prompt: "changed",
        model: null,
      }),
    ).rejects.toThrow("host launch identity conflict")
    const key = createHash("sha256").update("finished").digest("hex")
    await mkdir(join(ioRoot, key), { mode: 0o700 })
    await writeFile(join(ioRoot, key, "input"), "old prompt")
    const { utimes } = await import("node:fs/promises")
    const old = new Date(Date.now() - 8 * 86400000)
    await utimes(join(custodyRoot, `${key}.json`), old, old)
    const until = Date.now() + 4000
    while (await stat(join(custodyRoot, `${key}.json`)).catch(() => null)) {
      if (Date.now() > until) throw new Error("host did not collect expired custody")
      await Bun.sleep(50)
    }
    expect(await stat(join(ioRoot, key)).catch(() => null)).toBeNull()
  } finally {
    releaseSlow()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function deployedHost(
  root: string,
  policy: import("../../src/agent-host/config").CredentialPolicy,
) {
  // Only the explicitly marked disposable CI VM installs system files.
  expect(process.env.WORKFLOWD_AGENT_DEPLOYED_TEST).toBe("1")
  const command = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (status !== 0) throw new Error(`${args.join(" ")}: ${stdout} ${stderr}`)
    return stdout
  }
  const marker = join(root, "deployed")
  if (!(await stat(marker).catch(() => null))) {
    // Existing production policy is never overwritten, even if the test flag is set.
    expect(await stat("/etc/workflowd/agent-host.json").catch(() => null)).toBeNull()
    expect(await stat("/etc/workflowd/agent-git.env").catch(() => null)).toBeNull()
    expect(
      await stat("/etc/systemd/system/workflowd-agent-host.service").catch(() => null),
    ).toBeNull()
    for (const directory of [
      "/etc/workflowd",
      "/usr/local/libexec",
      "/etc/systemd/system/workflowd-agent-host.service.d",
      "/var/lib/workflowd/model-credentials",
      "/var/lib/workflowd/agent-host",
      "/var/lib/workflowd/agent-io",
    ])
      await mkdir(directory, { recursive: true })
    await command([
      process.execPath,
      "build",
      join(import.meta.dir, "../../src/agent-host/server.ts"),
      "--compile",
      "--outfile",
      "/usr/local/libexec/workflowd-agent-host",
    ])
    await copyFile(
      join(import.meta.dir, "../../deploy/systemd/workflowd-agent-host.service"),
      "/etc/systemd/system/workflowd-agent-host.service",
    )
    await writeFile("/etc/workflowd/agent-host.json", JSON.stringify(policy), { mode: 0o600 })
    await writeFile(
      "/etc/workflowd/agent-git.env",
      Object.entries(identity)
        .map(([key, value]) => `${key}="${value}"`)
        .join("\n"),
      { mode: 0o600 },
    )
    // Add only the private fixture store to the unit's writable paths. All
    // production capabilities, namespaces and restrictions remain in force.
    await writeFile(
      "/etc/systemd/system/workflowd-agent-host.service.d/fixture.conf",
      `[Service]\nReadWritePaths=${root}\n`,
    )
    await command(["systemctl", "daemon-reload"])
    await writeFile(marker, "installed")
  }
  await command(["systemctl", "restart", "workflowd-agent-host.service"])
  const deadline = Date.now() + 10000
  while (!(await stat("/run/workflowd-agent-host/control.sock").catch(() => null))) {
    if (Date.now() > deadline)
      throw new Error(
        await command([
          "journalctl",
          "-u",
          "workflowd-agent-host.service",
          "--no-pager",
          "-n",
          "40",
        ]),
      )
    await Bun.sleep(50)
  }
  return {
    close: async () => {
      await command(["systemctl", "stop", "workflowd-agent-host.service"])
    },
  }
}

test("the host configuration refuses missing or relative sockets when a policy exists", async () => {
  const { requireAgentHostSocket } = await import("../../src/agent-host/config")
  const root = await mkdtemp(join(tmpdir(), "host-policy-admission-"))
  const policy = join(root, "policy.json")
  try {
    await requireAgentHostSocket(undefined, policy)
    await writeFile(policy, "{}")
    await expect(requireAgentHostSocket(undefined, policy)).rejects.toThrow(
      "required by the installed host policy",
    )
    await requireAgentHostSocket("/run/host.sock", policy)
    await expect(requireAgentHostSocket("relative.sock", policy)).rejects.toThrow(
      "must be absolute",
    )
    await expect(requireAgentHostSocket(undefined, join(policy, "child"))).rejects.toMatchObject({
      code: "ENOTDIR",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a launch-capable root host requires its own complete Git identity configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-git-config-"))
  const login = { canonical: "/unused", benLink: "/unused", agentLink: "/unused" }
  const policy = {
    root,
    ownerUid: 0,
    controllerUid: 1,
    agentUid: 2,
    groupGid: 2,
    codex: login,
    claude: login,
    consumerExecutables: [],
    launch: {
      custodyRoot: root,
      ioRoot: root,
      home: root,
      workspaceRoot: root,
      bun: "/unused",
      worker: "/unused",
      codex: "/unused",
      claude: "/unused",
    },
  }
  try {
    for (const env of [{}, { WORKFLOWD_AGENT_GIT_NAME: "Fixture" }])
      await expect(serveHost(join(root, "host.sock"), policy, undefined, env)).rejects.toThrow(
        "WORKFLOWD_AGENT_GIT",
      )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
