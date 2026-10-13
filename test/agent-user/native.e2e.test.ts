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

import { chown, readFile, realpath, copyFile, readdir, stat, lstat } from "node:fs/promises"
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
                cmd: `id -u > '${proof}'; echo $$ > '${proof}-pid'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi; if ls '${custodyRoot}' >/dev/null 2>&1; then echo custody-exposed >> '${proof}'; else echo custody-denied >> '${proof}'; fi${simulatedManager ? "" : "; sleep 300"}`,
                yield_time_ms: 1000,
              }
            : {
                command: `id -u > '${proof}'; echo $$ > '${proof}-pid'; if cat '${canary}' >/dev/null 2>&1; then echo exposed >> '${proof}'; else echo denied >> '${proof}'; fi; if ls '${custodyRoot}' >/dev/null 2>&1; then echo custody-exposed >> '${proof}'; else echo custody-denied >> '${proof}'; fi${simulatedManager ? "" : "; sleep 300"}`,
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
      const descendant = Number((await readFile(`${proof}-pid`, "utf8")).trim())
      if (!simulatedManager) {
        expect(await readFile(`/proc/${descendant}/status`, "utf8")).toContain(
          `Uid:\t${agentUid}\t${agentUid}\t${agentUid}\t${agentUid}`,
        )
      }
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
      if (!simulatedManager) {
        const status = await readFile(`/proc/${descendant}/status`, "utf8").catch(() => null)
        if (status !== null) expect(status).toContain("State:\tZ")
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
            socket: await lstat(join(io, "rpc.sock"))
              .then((info) => ({
                uid: info.uid,
                mode: info.mode,
                socket: info.isSocket(),
                link: info.isSymbolicLink(),
              }))
              .catch(() => null),
            stderr: await readFile(join(io, "stderr"), "utf8").catch(() => "missing"),
          }),
        )
      })
      await server.initialize()
      expect(await server.rpc.request("thread/list", { limit: 1 })).toHaveProperty("data")
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
      const count = codex.requests.length
      await rm(policy.codex.agentLink)
      await expect(
        attached.rpc.request("thread/start", { cwd: workspaceRoot }),
      ).rejects.toMatchObject({ reason: "shared_credential_link_broken" })
      expect(codex.requests.length).toBe(count)
      await attached.detach()
      expect(await sweepOrphanAppServers("workflowd-resident-", new Set(), path)).toContain(
        owned.unit,
      )
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
      host = await serveCredentialHost(path, policy)
      expect(await controllerProgram(true)).toEqual(first)
      const owned = Schema.decodeUnknownSync(OwnedProcess)(
        await call({ operation: "inspect", runId: hostId }),
      )
      expect(owned.uid).toBe(agentUid)
      await call({ operation: "stop", runId: hostId, launchId })
      expect((await terminal(hostId)).active).toBe(false)
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
    expect(await discovery.discover(AbortSignal.timeout(1000))).toEqual(output)
    expect(stops).toEqual([starts[0]!.runId])
    output = { status: "unsupported" }
    expect(await discovery.discover(AbortSignal.timeout(1000))).toEqual(output)
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
    expect(starts.at(-1)?.runId).toBe(starts.at(-2)?.runId)
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
