import { randomUUID, createHash } from "node:crypto"
import { relinkCredentials } from "../../src/agent-host/credential-relink"
import { requestAgentHost } from "../../src/agent-host/client"
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

import { chown, readFile, realpath, copyFile, readdir, stat } from "node:fs/promises"
import { nativeModelFixture } from "../sandbox/native-fixture"
import { Effect, Schema } from "effect"
import { makeCodexCli } from "../../src/kernel/codex-session"
import { makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import { makeCodexDiscovery } from "../../src/execution/codex"
import { agentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { launchAppServer, attachAppServer, sweepOrphanAppServers } from "../../src/resident/process"
import { makeClaudeCli } from "../../src/kernel/claude-session"
import { makeClaudeResumeExecutor } from "../../src/remote/claude-resume-executor"
import type { ClaudeResumeJobV1 } from "../../src/remote/contract"
import { OwnedProcess, type HostRequest } from "../../src/agent-host/protocol"

async function nativeBoundary(simulatedManager: boolean) {
  expect(process.getuid!()).toBe(0)
  const controllerUid = simulatedManager ? 0 : Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID)
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
  const path = join(root, "host.sock")
  const supervisor = simulatedManager ? fixtureSupervisor(agentUid, groupGid) : undefined
  let host = await serveCredentialHost(path, policy, supervisor)
  const units = new Set<string>()
  const call = async (request: HostRequest, uid = controllerUid): Promise<unknown> => {
    if (simulatedManager && uid === controllerUid) {
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
  const repair = async (client: "codex" | "claude") => {
    const login = policy[client]
    const synthetic = await readFile(login.canonical)
    await rm(login.benLink)
    await writeFile(login.benLink, synthetic, { mode: 0o600 })
    await chown(login.benLink, controllerUid, groupGid)
    await relinkCredentials(policy, client, "ben")
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
      const proof = join(workspaceRoot, `${client}-proof`)
      fixture.actions.push({
        name: client === "codex" ? "exec_command" : "Bash",
        arguments:
          client === "codex"
            ? {
                cmd: `id -u > '${proof}'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi${simulatedManager ? "" : "; sleep 300"}`,
                yield_time_ms: 1000,
              }
            : {
                command: `id -u > '${proof}'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi${simulatedManager ? "" : "; sleep 300"}`,
                timeout: 1000,
              },
      })
      fixture.holdAfter(1)
      const cli = simulatedManager
        ? (client === "codex" ? makeCodexCli : makeClaudeDispatchCli)({
            binary: "unused",
            credentialSocket: path,
            custodyRoot: "/never-readable-controller-custody",
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
      while (!(await readFile(proof, "utf8").catch(() => "")).includes("denied")) {
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
      expect(await readFile(proof, "utf8")).toBe(`${agentUid}\ndenied\n`)
      await host.close()
      await rm(path, { force: true })
      host = await serveCredentialHost(path, policy, supervisor)
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
      if (cli?.ownership === "transient-exec") {
        const attached = await Effect.runPromise(cli.attach({ runId }))
        if (!attached) throw new Error("native adapter lost host custody")
        await Effect.runPromise(attached.cancel)
        const events = []
        for await (const event of attached.events) events.push(event)
        expect(events.some((event) => event.type === "thread.started")).toBe(true)
        expect((await Effect.runPromise(attached.exited)).exitCode).toBe(-1)
      }
      const stopped = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "stop", runId, launchId: process.launchId }),
      )
      expect(stopped.active).toBe(false)
      expect(await readFile(`/proc/${process.pid}/status`, "utf8").catch(() => null)).toBeNull()
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
      const catalog = await makeCodexDiscovery("codex:local", {
        command: ["unused"],
        credentialSocket: path,
      }).discover(AbortSignal.timeout(30000))
      expect(Array.isArray(catalog)).toBe(true)
      const input = {
        repository: "/controller/repository-selector",
        directory: join(workspaceRoot, "clone"),
        branch: "agent-work",
      }
      await Effect.runPromise(agentRunWorktrees(path).create(input))
      await Effect.runPromise(agentRunWorktrees(path).create(input))
      expect((await stat(join(input.directory, ".git"))).uid).toBe(agentUid)
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
      host = await serveCredentialHost(path, policy)
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
      const executor = makeClaudeResumeExecutor({
        cli: makeClaudeCli({ binary: "unused", credentialSocket: path }),
        allowedDirectories: [workspaceRoot],
      })
      expect((await Effect.runPromise(executor.execute(payload, deliveryId))).status).toBe(
        "succeeded",
      )
      expect((await Effect.runPromise(executor.recover!(payload, deliveryId))).status).toBe(
        "succeeded",
      )
    }
    expect(claude.requests.length - baseline).toBe(2)
    if (simulatedManager) {
      const launchId = randomUUID()
      const runId = `agent-run-resident-${randomUUID()}`
      const server = await launchAppServer(
        {
          binary: "unused",
          home: "/never-readable-controller-home",
          hostSocket: path,
          runId,
          launchId,
        },
        () => {},
      ).catch(async (error: unknown) => {
        const io = join(ioRoot, createHash("sha256").update(`${runId}-${launchId}`).digest("hex"))
        throw new Error(
          JSON.stringify({
            error: String(error),
            stderr: await readFile(join(io, "stderr"), "utf8").catch(() => "missing"),
          }),
        )
      })
      await server.initialize()
      expect(await server.rpc.request("thread/list", { limit: 1 })).toHaveProperty("data")
      const count = codex.requests.length
      await rm(policy.codex.agentLink)
      await expect(
        server.rpc.request("thread/start", { cwd: workspaceRoot }),
      ).rejects.toMatchObject({ reason: "shared_credential_link_broken" })
      expect(codex.requests.length).toBe(count)
      await repair("codex")
      await server.detach()
      const hostId = `${runId}-${launchId}`
      const owned = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "inspect", runId: hostId }),
      )
      const attached = await attachAppServer(
        {
          socket: hostId,
          unit: owned.unit,
          launchId,
          invocation: server.invocation,
          hostSocket: path,
        },
        () => {},
      )
      expect(attached.pid).toBe(server.pid)
      await attached.initialize()
      await attached.detach()
      expect(await sweepOrphanAppServers("workflowd-resident-", new Set(), path)).toContain(
        owned.unit,
      )
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
    await codex.close()
    await claude.close()
    await rm(root, { recursive: true, force: true })
  }
}

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
      const child = Bun.spawn(
        [
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
      try {
        process.kill(-state.child.pid, "SIGKILL")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
      await state.child.exited
      state.stopped = true
      return ""
    }
    return `LoadState=loaded\nActiveState=${state.stopped ? "inactive" : "active"}\nSubState=${state.child.exitCode === null ? "running" : "exited"}\nMainPID=${state.child.exitCode === null ? state.child.pid : 0}\nInvocationID=${state.invocation}\nDescription=${state.description}\nUser=${agentUid}\nExecMainCode=1\nExecMainStatus=${state.child.exitCode ?? 0}\n`
  }
}
