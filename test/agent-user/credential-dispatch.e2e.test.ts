import { expect, test } from "bun:test"
import type { Schema } from "effect"
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCredentialAdmission } from "../../src/agent-host/credentials"
import { relinkCredentials } from "../../src/agent-host/credential-relink"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "credential-dispatch-"))
  const controllerUid = Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID ?? process.getuid!())
  const agentUid = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID ?? process.getuid!())
  const groupGid = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID ?? process.getgid!())
  const store = join(root, "store")
  const benHome = join(root, "ben")
  const agentHome = join(root, "agent")
  for (const directory of [store, benHome, agentHome])
    await mkdir(directory, { mode: directory === store ? 0o710 : 0o700 })
  await chown(root, process.getuid!(), groupGid)
  await chmod(root, 0o711)
  await chown(store, process.getuid!(), groupGid)
  await chown(benHome, controllerUid, groupGid)
  await chown(agentHome, agentUid, groupGid)
  const canonical = join(store, "auth.json")
  const benLink = join(benHome, "auth.json")
  const agentLink = join(agentHome, "auth.json")
  await writeFile(canonical, "synthetic-generation-1", { mode: 0o660 })
  await chown(canonical, process.getuid!(), groupGid)
  await chmod(canonical, 0o660)
  await symlink(canonical, benLink)
  await symlink(canonical, agentLink)
  const policy = {
    root: store,
    ownerUid: process.getuid!(),
    groupGid,
    controllerUid,
    agentUid,
    codex: { canonical, benLink, agentLink },
    claude: { canonical, benLink, agentLink },
    consumerExecutables: [],
  }
  return { policy, close: () => rm(root, { recursive: true, force: true }) }
}

if (process.getuid!() !== 0 && !process.env.WORKFLOWD_AGENT_TEST_BEN_UID) {
  test("credential administration in a private user and PID namespace", async () => {
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--mount-proc",
        "/bin/sh",
        "-c",
        'mount -t tmpfs -o mode=1777 tmpfs /tmp && exec "$@"',
        "fixture",
        process.execPath,
        "test",
        import.meta.filename,
        "--test-name-pattern",
        "^(a replaced login|missing links|an admission lease|interrupted repair|repair after|the host|refused installed|relink |a FIFO)",
      ],
      {
        env: {
          ...process.env,
          PATH: `${join(import.meta.dir, "../resources/forbidden")}:${process.env.PATH}`,
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    expect(await child.exited).toBe(0)
  }, 120000)
}

const adminTest = (name: string, run: () => Promise<void>, timeout?: number) => {
  if (process.getuid!() === 0) test(name, run, timeout)
}

adminTest(
  "a replaced login refuses even with identical bytes; explicit relink restores both links",
  async () => {
    const { policy, close } = await fixture()
    try {
      await checkCredentialAdmission(policy, "codex")
      await rm(policy.codex.benLink)
      await writeFile(policy.codex.benLink, "synthetic-generation-1", { mode: 0o600 })
      await expect(checkCredentialAdmission(policy, "codex")).rejects.toMatchObject({
        reason: "shared_credential_diverged",
      })
      await writeFile(policy.codex.benLink, "synthetic-generation-2")
      await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
      await relinkCredentials(policy, "codex", "ben")
      await checkCredentialAdmission(policy, "codex")
      expect((await lstat(policy.codex.benLink)).isSymbolicLink()).toBe(true)
      expect((await lstat(policy.codex.agentLink)).isSymbolicLink()).toBe(true)
      expect(await readFile(policy.codex.agentLink, "utf8")).toBe("synthetic-generation-2")
      expect((await lstat(policy.codex.canonical)).mode & 0o777).toBe(0o660)
    } finally {
      await close()
    }
  },
)

adminTest(
  "missing links, permission loss, competing replacements and interrupted repair stay refused",
  async () => {
    const { policy, close } = await fixture()
    try {
      await chmod(policy.codex.canonical, 0o600)
      await expect(checkCredentialAdmission(policy, "codex")).rejects.toMatchObject({
        reason: "shared_credential_permissions_invalid",
      })
      await chmod(policy.codex.canonical, 0o660)
      await rm(policy.codex.benLink)
      await expect(checkCredentialAdmission(policy, "codex")).rejects.toMatchObject({
        reason: "shared_credential_link_broken",
      })
      await writeFile(policy.codex.benLink, "synthetic-generation-2")
      await rm(policy.codex.agentLink)
      await writeFile(policy.codex.agentLink, "synthetic-generation-3")
      await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
        reason: "shared_credential_diverged",
      })
      await rm(policy.codex.agentLink)
      await symlink(policy.codex.canonical, policy.codex.agentLink)
      await writeFile(join(policy.root, "codex.repair.json"), "{}", { mode: 0o600 })
      await expect(checkCredentialAdmission(policy, "codex")).rejects.toMatchObject({
        reason: "credential_relink_in_progress",
      })
    } finally {
      await close()
    }
  },
)

adminTest("an admission lease excludes administrative repair until dispatch handoff", async () => {
  const { credentialLock } = await import("../../src/agent-host/credentials")
  const { policy, close } = await fixture()
  try {
    const release = await credentialLock(policy, false)
    try {
      await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
        reason: "credential_relink_in_progress",
      })
    } finally {
      await release()
    }
    if ((await lstat(policy.codex.benLink).catch(() => null))?.isFile())
      await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
    await relinkCredentials(policy, "codex", "ben")
  } finally {
    await close()
  }
})

adminTest(
  "interrupted repair can resume from the selected source without choosing by mtime",
  async () => {
    const { policy, close } = await fixture()
    try {
      await rm(policy.codex.benLink)
      await writeFile(policy.codex.benLink, "synthetic-generation-2", { mode: 0o600 })
      await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
      const source = await lstat(policy.codex.benLink)
      await writeFile(
        join(policy.root, "codex.repair.json"),
        JSON.stringify({
          client: "codex",
          source: "ben",
          sourceDevice: source.dev,
          sourceInode: source.ino,
          sourceCtimeMs: source.ctimeMs,
          sourceMtimeMs: source.mtimeMs,
          sourceSize: source.size,
        }),
        { mode: 0o600 },
      )
      await relinkCredentials(policy, "codex", "ben")
      await checkCredentialAdmission(policy, "codex")
      expect(await readFile(policy.codex.agentLink, "utf8")).toBe("synthetic-generation-2")
    } finally {
      await close()
    }
  },
)

for (const state of ["original", "removed", "linked", "replaced"] as const) {
  adminTest(
    `repair after canonical replacement handles a ${state} source without importing it again`,
    async () => {
      const { policy, close } = await fixture()
      try {
        const { canonical, benLink, agentLink } = policy.codex
        await rm(benLink)
        await writeFile(benLink, "synthetic-generation-2", { mode: 0o600 })
        await chown(benLink, policy.controllerUid, policy.groupGid)
        const source = await lstat(benLink)
        await writeFile(canonical, "synthetic-generation-2")
        const staged = await lstat(canonical)
        await writeFile(
          join(policy.root, "codex.repair.json"),
          JSON.stringify({
            client: "codex",
            source: "ben",
            sourceDevice: source.dev,
            sourceInode: source.ino,
            sourceCtimeMs: source.ctimeMs,
            sourceMtimeMs: source.mtimeMs,
            sourceSize: source.size,
            stagedDevice: staged.dev,
            stagedInode: staged.ino,
          }),
          { mode: 0o600 },
        )
        if (state !== "original") await rm(benLink)
        if (state === "linked") await symlink(canonical, benLink)
        if (state === "replaced") await symlink(agentLink, benLink)
        await expect(checkCredentialAdmission(policy, "codex")).rejects.toMatchObject({
          reason: "credential_relink_in_progress",
        })
        if (state === "replaced") {
          await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
            reason: "shared_credential_diverged",
          })
          expect(await readFile(canonical, "utf8")).toBe("synthetic-generation-2")
        } else {
          if ((await lstat(policy.codex.benLink).catch(() => null))?.isFile())
            expect((await lstat(policy.codex.benLink)).uid).toBe(policy.controllerUid)
          await relinkCredentials(policy, "codex", "ben")
          await checkCredentialAdmission(policy, "codex")
          expect((await lstat(canonical)).ino).toBe(staged.ino)
          expect(await readFile(agentLink, "utf8")).toBe("synthetic-generation-2")
        }
      } finally {
        await close()
      }
    },
  )
}

async function asIdentity(uid: number, group: number, code: string, env: Record<string, string>) {
  const command = [process.execPath, "--eval", code]
  const child = Bun.spawn(
    uid === process.getuid!()
      ? command
      : [
          "/usr/bin/setpriv",
          "--reuid",
          String(uid),
          "--regid",
          String(group),
          "--clear-groups",
          ...command,
        ],
    { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" },
  )
  const [output, errors, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(errors).toBe("")
  expect(status).toBe(0)
  const result: unknown = JSON.parse(output)
  return result
}

const clientModule = new URL("../../src/agent-host/client.ts", import.meta.url).pathname
const admissionCode = `
  const { acquireCredentialAdmission } = await import(process.env.CLIENT_MODULE);
  try { const release = await acquireCredentialAdmission(process.env.SOCKET, "codex"); await release(); console.log(JSON.stringify({ admitted: true })); }
  catch (error) { console.log(JSON.stringify({ reason: error.reason })); }
`

adminTest(
  "the host authenticates peer UID and checks again after successful preflight",
  async () => {
    const { serveCredentialHost } = await import("../../src/agent-host/server")
    const { policy, close } = await fixture()
    const socket = join(policy.root, "host.sock")
    const host = await serveCredentialHost(socket, policy)
    const env = { SOCKET: socket, CLIENT_MODULE: clientModule }
    try {
      expect(await asIdentity(policy.controllerUid, policy.groupGid, admissionCode, env)).toEqual({
        admitted: true,
      })
      if (policy.agentUid !== policy.controllerUid) {
        // Permit reaching SO_PEERCRED so this proves protocol rejection, independently of the socket ACL.
        await chmod(socket, 0o666)
        expect(await asIdentity(policy.agentUid, policy.groupGid, admissionCode, env)).toEqual({
          reason: "shared_credential_permissions_invalid",
        })
        await chmod(socket, 0o600)
      }
      await rm(policy.codex.agentLink)
      expect(await asIdentity(policy.controllerUid, policy.groupGid, admissionCode, env)).toEqual({
        reason: "shared_credential_link_broken",
      })
    } finally {
      await host.close()
      await close()
    }
  },
)

adminTest("refused installed Codex and Claude dispatch start no unit or process", async () => {
  const { serveCredentialHost } = await import("../../src/agent-host/server")
  const { policy, close } = await fixture()
  const socket = join(policy.root, "host.sock")
  const host = await serveCredentialHost(socket, policy)
  try {
    await rm(policy.codex.benLink)
    await writeFile(policy.codex.benLink, "replacement", { mode: 0o600 })
    const { utimes } = await import("node:fs/promises")
    await utimes(policy.codex.benLink, 1, 1)
    for (const client of ["codex", "claude"]) {
      const binary = Bun.which(client)
      expect(binary).not.toBeNull()
      const result = await asIdentity(
        policy.controllerUid,
        policy.groupGid,
        `
        const { Effect } = await import("effect");
        const { makeCodexCli } = await import(process.env.CODEX_MODULE);
        const { makeClaudeDispatchCli } = await import(process.env.CLAUDE_MODULE);
        const { credentialReason } = await import(process.env.PROTOCOL_MODULE);
        const { lstat } = await import("node:fs/promises");
        let commands = 0;
        const options = { binary: process.env.BINARY, credentialSocket: process.env.SOCKET,
          custodyRoot: process.env.CUSTODY, runCommand: async () => { commands++; throw new Error("unexpected command"); } };
        const cli = process.env.CLIENT === "codex" ? makeCodexCli(options) : makeClaudeDispatchCli(options);
        const result = await Effect.runPromise(cli.spawn({ runId: "refused", directory: process.env.HOME,
          prompt: "synthetic", model: null }).pipe(Effect.result));
        console.log(JSON.stringify({ reason: result._tag === "Failure" ? credentialReason(result.failure) : "unexpected_start",
          commands, custodyCreated: await lstat(process.env.CUSTODY).then(() => true, () => false) }));
      `,
        {
          SOCKET: socket,
          CLIENT: client,
          BINARY: binary!,
          HOME: join(policy.root, "..", "ben"),
          CUSTODY: join(policy.root, "..", "ben", "custody"),
          CODEX_MODULE: new URL("../../src/kernel/codex-session.ts", import.meta.url).pathname,
          CLAUDE_MODULE: new URL("../../src/kernel/claude-dispatch.ts", import.meta.url).pathname,
          PROTOCOL_MODULE: new URL("../../src/agent-host/protocol.ts", import.meta.url).pathname,
        },
      )
      expect(result).toEqual({
        reason: "shared_credential_diverged",
        commands: 0,
        custodyCreated: false,
      })
    }
  } finally {
    await host.close()
    await close()
  }
})

test("resident delivery and remote Claude extraction retain refusal and do not retry", async () => {
  const { Effect } = await import("effect")
  const { credentialRefusal } = await import("../../src/agent-host/protocol")
  const { deliverResident } = await import("../../src/resident/delivery")
  const { makeClaudeResumeExecutor } = await import("../../src/remote/claude-resume-executor")
  const { WorkspaceError } = await import("../../src/workspace/errors")
  const refusal = credentialRefusal("claude", "shared_credential_diverged")
  expect(
    await Effect.runPromise(
      deliverResident(() => Promise.reject(refusal), {
        id: "test",
        thread_id: "test",
        prompt: "test",
        state: "pending",
      }),
    ),
  ).toEqual({ reason: "shared_credential_diverged" })
  let calls = 0
  const executor = makeClaudeResumeExecutor({
    allowedDirectories: ["/fixture"],
    cli: {
      sessionExists: () => Effect.succeed(true),
      resume: () =>
        ++calls === 1
          ? Effect.succeed('{"result":"awake"}')
          : Effect.fail(new WorkspaceError({ operation: "admission", cause: refusal })),
    },
  })
  expect(
    await Effect.runPromise(
      executor.execute({
        kind: "claude_resume",
        hostId: "fixture",
        nativeSessionId: "fixture",
        directory: "/fixture",
        prompt: "fixture",
        extractionSchemaJson: "{}",
        turnTimeoutMs: 1000,
      }),
    ),
  ).toEqual({ status: "failed", failureReason: "shared_credential_diverged" })
  expect(calls).toBe(2)
})

for (const refuseWake of [true, false]) {
  test(`same-host Claude refusal preserves its reason without replay; wake=${refuseWake}`, async () => {
    const { createHash } = await import("node:crypto")
    const { SqliteClient } = await import("@effect/sql-sqlite-bun")
    const { Effect, Layer } = await import("effect")
    const { AGENT_WAKE_CONTRACT, AgentWakeResult, agentWakePrompt } =
      await import("../../src/kernel/agent-wait-ingress")
    const { runClaudeResumeIteration } = await import("../../src/kernel/claude-resume-worker")
    const { ClaudeCli, claudeEndpointIdentity, claudeSessionCustodyId } =
      await import("../../src/kernel/claude-session")
    const { KernelEventStoreLive } = await import("../../src/kernel/event-store")
    const { KernelJobStoreLive } = await import("../../src/kernel/job-store")
    const { KernelSessionStore, KernelSessionStoreLive } =
      await import("../../src/kernel/session-store")
    const { ClaudeResumeRemoteProducerLive } =
      await import("../../src/remote/claude-resume-producer")
    const { toJsonSchemaObject } = await import("../../src/json")
    const { WorkflowStoreLive } = await import("../../src/store")

    const at = new Date("2026-08-31T09:00:00.000Z")
    const native = "0c0ffee0-cafe-4dad-b0ba-000000000001"
    const directory = "/home/ben/Documents/repos/workflowd"

    const storesLayer = (() => {
      const bootstrap = WorkflowStoreLive.pipe(
        Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
      )
      const kernel = Layer.mergeAll(
        KernelSessionStoreLive,
        KernelEventStoreLive,
        KernelJobStoreLive,
      ).pipe(Layer.provideMerge(bootstrap))
      return ClaudeResumeRemoteProducerLive.pipe(Layer.provideMerge(kernel))
    })()

    const contract = {
      name: AGENT_WAKE_CONTRACT.name,
      version: AGENT_WAKE_CONTRACT.version,
      schema: AgentWakeResult as Schema.Codec<unknown, unknown>,
      jsonSchema: toJsonSchemaObject(AgentWakeResult),
      maxOutputBytes: 16_384,
    }

    const options = {
      owningHostId: "mint",
      workerId: "test:claude-resume",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      resumeTimeoutMs: 5_000,
      retryDelayMs: 1_000,
      claudeHosts: ["ben-arch"],
      remoteTurnTimeoutMs: 120_000,
      now: () => at,
      contracts: [contract],
    }

    const wake = agentWakePrompt("Your child finished; acknowledge.")

    const seed = Effect.gen(function* () {
      const store = yield* KernelSessionStore
      yield* store.registerResource({
        resourceId: "claude-parent-resource",
        owningHostId: "mint",
        absolutePath: directory,
        kind: "checkout",
        createdAt: at,
      })
      yield* store.registerSession({
        sessionId: claudeSessionCustodyId(native),
        providerKind: "claude",
        providerVersion: 1,
        providerId: "claude-cli",
        serverId: "mint",
        owningHostId: "mint",
        endpointAlias: "local-cli",
        endpointIdentity: claudeEndpointIdentity("mint"),
        nativeSessionId: native,
        resourceId: "claude-parent-resource",
        createdAt: at,
      })
      yield* store.registerResumeRequest({
        requestId: "claude-resume-1",
        sessionId: claudeSessionCustodyId(native),
        owningHostId: "mint",
        prompt: wake.resumePrompt,
        promptText: wake.resumePromptText,
        promptSha256: createHash("sha256").update(wake.resumePromptText, "utf8").digest("hex"),
        outputContract: AGENT_WAKE_CONTRACT.name,
        outputContractVersion: AGENT_WAKE_CONTRACT.version,
        maxAttempts: 3,
        runAt: at,
        createdAt: at,
      })
    })
    const { credentialRefusal } = await import("../../src/agent-host/protocol")
    const { WorkspaceError } = await import("../../src/workspace/errors")
    let calls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed
        return yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, {
            sessionExists: () => Effect.succeed(true),
            resume: () =>
              Effect.suspend(() => {
                calls++
                return !refuseWake && calls === 1
                  ? Effect.succeed(JSON.stringify({ result: "ACK" }))
                  : Effect.fail(
                      new WorkspaceError({
                        operation: "admission",
                        cause: credentialRefusal("claude", "shared_credential_link_broken"),
                      }),
                    )
              }),
          }),
        )
      }).pipe(Effect.provide(storesLayer)),
    )
    expect(result).toMatchObject({
      status: "operator_required",
      reason: "shared_credential_link_broken",
    })
    expect(calls).toBe(refuseWake ? 1 : 2)
  })
}

test("credential refusal invalidates a cached capability observation", async () => {
  const { makeExecutionCapabilities } = await import("../../src/execution-capabilities")
  const { credentialRefusal } = await import("../../src/agent-host/protocol")
  let broken = false
  const catalog = makeExecutionCapabilities({
    host: "fixture",
    timeoutMs: 1000,
    refreshMs: 60000,
    sources: [
      {
        executor: "codex",
        discover: () => Promise.resolve([{ provider: null, model: "fixture" }]),
        checkCredentials: () =>
          broken
            ? Promise.reject(credentialRefusal("codex", "shared_credential_link_broken"))
            : Promise.resolve(),
      },
    ],
  })
  try {
    expect((await catalog.list()).capabilities).toHaveLength(1)
    broken = true
    const refused = await catalog.list()
    expect(refused.capabilities).toHaveLength(0)
    expect(refused.sources[0]?.reason).toBe("shared_credential_link_broken")
  } finally {
    await catalog.close()
  }
})

test("host transport failures preserve the requested client and actual cause", async () => {
  const { acquireCredentialAdmission, withCredentialAdmission } =
    await import("../../src/agent-host/client")
  const { Effect } = await import("effect")
  const socket = "/tmp/workflowd-no-such-credential-host.sock"
  await expect(acquireCredentialAdmission(socket, "claude")).rejects.toMatchObject({
    client: "claude",
    reason: "credential_host_unreachable_or_timed_out",
    detail: expect.stringContaining("ENOENT"),
  })
  const result = await Effect.runPromise(
    withCredentialAdmission(socket, "opencode", Effect.void).pipe(Effect.result),
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      client: "opencode",
      reason: "credential_host_unreachable_or_timed_out",
      detail: expect.stringContaining("ENOENT"),
    },
  })
})

test("a credential-guarded worker never resumes internally after its link breaks", async () => {
  const { runCliWorker } = await import("../../src/kernel/codex-worker")
  const root = await mkdtemp(join(tmpdir(), "credential-worker-"))
  const old = process.env.WORKFLOWD_AGENT_HOST_SOCKET
  try {
    process.env.WORKFLOWD_AGENT_HOST_SOCKET = join(root, "host.sock")
    await writeFile(join(root, "prompt"), "synthetic")
    await symlink(join(root, "canonical"), join(root, "auth.json"))
    const script = join(root, "client.sh")
    await writeFile(
      script,
      `#!/bin/sh\necho start >> starts\nrm -f auth.json\nprintf '%s\\n' '{"type":"thread.started","thread_id":"fixture"}' '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}'\nsleep 0.1\nexit 1\n`,
      { mode: 0o700 },
    )
    expect(
      await runCliWorker(
        {
          binary: script,
          directory: root,
          promptFile: join(root, "prompt"),
          resultFile: join(root, "result"),
          eventsFile: join(root, "events"),
          stderrFile: join(root, "stderr"),
          maxOutputBytes: 65536,
          model: null,
        },
        [script, "-"],
        true,
      ),
    ).toBe(1)
    expect((await readFile(join(root, "starts"), "utf8")).trim().split("\n")).toHaveLength(1)
    expect(await lstat(join(root, "auth.json")).catch(() => null)).toBeNull()
  } finally {
    if (old === undefined) delete process.env.WORKFLOWD_AGENT_HOST_SOCKET
    else process.env.WORKFLOWD_AGENT_HOST_SOCKET = old
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

adminTest("relink refuses every live agent process, even an unrelated executable", async () => {
  const { policy, close } = await fixture()
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" })
  try {
    await expect(
      relinkCredentials({ ...policy, agentUid: process.getuid!() }, "claude", "ben"),
    ).rejects.toMatchObject({
      client: "claude",
      reason: "credential_relink_in_progress",
    })
  } finally {
    child.kill()
    await child.exited
    await close()
  }
})

for (const layout of ["claude", "codex-bundled", "codex-platform"] as const) {
  adminTest(
    `relink refuses a deleted controller executable in the ${layout} install root`,
    async () => {
      const { copyFile, readlink, unlink } = await import("node:fs/promises")
      const { dirname } = await import("node:path")
      const { policy, close } = await fixture()
      const install = join(policy.root, "install")
      const entrypoint = join(
        install,
        layout === "claude" ? "versions/current" : "@openai/codex/bin/codex.js",
      )
      const executable = join(
        install,
        layout === "claude"
          ? "versions/previous"
          : `@openai/${layout === "codex-bundled" ? "codex" : "codex-linux-x64"}/vendor/linux/codex/codex`,
      )
      await mkdir(dirname(entrypoint), { recursive: true })
      await mkdir(dirname(executable), { recursive: true })
      await copyFile("/bin/sleep", entrypoint)
      await copyFile("/bin/sleep", executable)
      const child = Bun.spawn([executable, "30"], { stdout: "ignore", stderr: "ignore" })
      try {
        await unlink(executable)
        expect(await readlink(`/proc/${child.pid}/exe`)).toBe(`${executable} (deleted)`)
        await expect(
          relinkCredentials(
            {
              ...policy,
              controllerUid: process.getuid!(),
              agentUid: 65533,
              consumerExecutables: [entrypoint],
            },
            "claude",
            "ben",
          ),
        ).rejects.toMatchObject({ reason: "credential_relink_in_progress" })
      } finally {
        child.kill()
        await child.exited
        await close()
      }
    },
  )
}

for (const operation of ["listProviders", "listModels"] as const) {
  test(`OpenCode ${operation} preserves credential refusal through ingress`, async () => {
    const { Effect } = await import("effect")
    const { credentialRefusal } = await import("../../src/agent-host/protocol")
    const { OpenCodeAdapterError } = await import("../../src/opencode/adapter")
    const { defaultState, makeProvider, makeLayer, worktrees, register, submission } =
      await import("../kernel/agent-run-ingress-harness")
    const provider = {
      ...makeProvider(defaultState()),
      [operation]: () =>
        Effect.fail(
          new OpenCodeAdapterError({
            operation,
            cause: credentialRefusal("opencode", "opencode_grant_migration_incomplete"),
          }),
        ),
    }
    const result = await Effect.runPromise(
      register(submission).pipe(Effect.provide(makeLayer(provider, worktrees([]))), Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "opencode_grant_migration_incomplete" },
    })
  })
}

for (const client of ["codex", "claude"] as const) {
  adminTest(
    `relink detects the installed native ${client} process for each UID`,
    async () => {
      const { realpath, stat } = await import("node:fs/promises")
      const { dirname, basename } = await import("node:path")
      const { policy, close } = await fixture()
      const entrypoint = Bun.which(client)!
      let native = await realpath(entrypoint)
      if (client === "codex" && basename(native) === "codex.js") {
        const scope = dirname(dirname(dirname(native)))
        const candidates = await Array.fromAsync(
          new Bun.Glob("codex*/vendor/*/{bin,codex}/codex").scan({ cwd: scope, absolute: true }),
        )
        expect(candidates.length).toBeGreaterThan(0)
        native = candidates[0]!
      }
      try {
        for (const uid of new Set([policy.controllerUid, policy.agentUid])) {
          const home = join(policy.root, "..", uid === policy.controllerUid ? "ben" : "agent")
          const config = join(home, `.${client}`)
          await mkdir(config, { mode: 0o700 })
          await chown(config, uid, policy.groupGid)
          const command = [
            native,
            ...(client === "codex"
              ? ["app-server"]
              : [
                  "-p",
                  "--input-format",
                  "stream-json",
                  "--output-format",
                  "stream-json",
                  "--verbose",
                ]),
          ]
          const child = Bun.spawn(
            uid === process.getuid!()
              ? command
              : [
                  "/usr/bin/setpriv",
                  "--reuid",
                  String(uid),
                  "--regid",
                  String(policy.groupGid),
                  "--clear-groups",
                  ...command,
                ],
            {
              cwd: home,
              env: {
                PATH: process.env.PATH!,
                HOME: home,
                CODEX_HOME: join(home, ".codex"),
                CLAUDE_CONFIG_DIR: join(home, ".claude"),
                HTTP_PROXY: "http://127.0.0.1:9",
                HTTPS_PROXY: "http://127.0.0.1:9",
                ALL_PROXY: "http://127.0.0.1:9",
              },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "ignore",
            },
          )
          try {
            const deadline = Date.now() + 5000
            while ((await realpath(`/proc/${child.pid}/exe`).catch(() => "")) !== native) {
              if (Date.now() >= deadline) throw new Error("native_client_not_running")
              await Bun.sleep(10)
            }
            expect((await stat(`/proc/${child.pid}`)).uid).toBe(uid)
            expect(child.exitCode).toBeNull()
            // Local namespaces have one mapped UID; use an unused agent UID to test executable matching there.
            await expect(
              relinkCredentials(
                {
                  ...policy,
                  agentUid: policy.agentUid === policy.controllerUid ? 65533 : policy.agentUid,
                  consumerExecutables: [entrypoint],
                },
                client,
                "ben",
              ),
            ).rejects.toMatchObject({ client, reason: "credential_relink_in_progress" })
          } finally {
            await child.stdin.end()
            const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
            try {
              await child.exited
            } finally {
              clearTimeout(timer)
            }
            // PID 1 owns orphaned client helpers in the private fixture namespace.
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
          }
        }
      } finally {
        await close()
      }
    },
    15000,
  )
}

adminTest("a FIFO substituted for the selected login cannot block relink", async () => {
  const { spyOn } = await import("bun:test")
  const filesystem = await import("node:fs/promises")
  const { constants } = await import("node:fs")
  const { spawnSync } = await import("node:child_process")
  const { policy, close } = await fixture()
  await rm(policy.codex.benLink)
  await writeFile(policy.codex.benLink, "synthetic-replacement", { mode: 0o600 })
  await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
  const original = filesystem.open
  let substituted = false
  let nonblocking = false
  const race = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    if (
      !substituted &&
      String(path).endsWith("/auth.json") &&
      typeof flags === "number" &&
      (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
    ) {
      substituted = true
      nonblocking = (flags & constants.O_NONBLOCK) !== 0
      if (!nonblocking) throw new Error("unsafe blocking open")
      await rm(policy.codex.benLink)
      expect(spawnSync("mkfifo", [policy.codex.benLink]).status).toBe(0)
    }
    return original(path, flags, mode)
  })
  try {
    await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
      reason: "shared_credential_diverged",
    })
    expect(substituted).toBe(true)
    expect(nonblocking).toBe(true)
    expect(await readFile(policy.codex.canonical, "utf8")).toBe("synthetic-generation-1")
  } finally {
    race.mockRestore()
    await close()
  }
})

test("admitted host protocol releases leases for guarded effects and promises", async () => {
  const { createServer } = await import("node:net")
  const { Effect } = await import("effect")
  const { guardCliCredentials, withCredentialAdmissionPromise } =
    await import("../../src/agent-host/client")
  const { WorkspaceError } = await import("../../src/workspace/errors")
  const root = await mkdtemp(join(tmpdir(), "admitted-transport-"))
  const socket = join(root, "host.sock")
  let admissions = 0
  let releases = 0
  const server = createServer((connection) => {
    connection.once("data", () => {
      admissions++
      connection.write('{"admitted":true}\n')
    })
    connection.on("end", () => {
      releases++
      connection.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    const cli = guardCliCredentials(
      {
        ownership: "resident-thread",
        preflight: Effect.void,
        cancelRun: () => Effect.void,
        spawn: () =>
          Effect.fail(new WorkspaceError({ operation: "fixture", cause: new Error("synthetic") })),
      },
      socket,
      "claude",
    )
    await Effect.runPromise(cli.preflight)
    expect(
      await Effect.runPromise(
        cli
          .spawn({ runId: "fixture", directory: root, prompt: "fixture", model: null })
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { operation: "fixture" } })
    expect(
      await withCredentialAdmissionPromise(socket, "opencode", () => Promise.resolve(42)),
    ).toBe(42)
    expect(admissions).toBe(3)
    const deadline = Date.now() + 1000
    while (releases !== admissions && Date.now() < deadline) await Bun.sleep(5)
    expect(releases).toBe(admissions)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

adminTest("relink refuses a non-dumpable agent process", async () => {
  const { policy, close } = await fixture()
  const command = [
    process.execPath,
    "--eval",
    `
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) process.exit(1);
    console.log("ready");
    setInterval(() => {}, 1000);
  `,
  ]
  const child = Bun.spawn(
    policy.agentUid === process.getuid!()
      ? command
      : [
          "/usr/bin/setpriv",
          "--reuid",
          String(policy.agentUid),
          "--regid",
          String(policy.groupGid),
          "--clear-groups",
          ...command,
        ],
    { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH! } },
  )
  try {
    const reader = child.stdout.getReader()
    try {
      expect((await reader.read()).done).toBe(false)
    } finally {
      reader.releaseLock()
    }
    await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
      reason: "credential_relink_in_progress",
    })
    expect(await readFile(policy.codex.canonical, "utf8")).toBe("synthetic-generation-1")
  } finally {
    child.kill("SIGKILL")
    await child.exited
    await close()
  }
})

for (const client of ["codex", "claude"] as const)
  for (const source of ["ben", "agent"] as const) {
    adminTest(
      `the host automatically relinks a newer ${source} ${client} login with the other link intact`,
      async () => {
        const { serveCredentialHost } = await import("../../src/agent-host/server")
        const { utimes } = await import("node:fs/promises")
        const { policy, close } = await fixture()
        const socket = join(policy.root, "auto.sock")
        const host = await serveCredentialHost(socket, policy)
        try {
          const login = policy[client]
          const selected = source === "ben" ? login.benLink : login.agentLink
          await utimes(login.canonical, 1, 1)
          await rm(selected)
          await writeFile(selected, "synthetic-new-login", { mode: 0o600 })
          await chown(
            selected,
            source === "ben" ? policy.controllerUid : policy.agentUid,
            policy.groupGid,
          )
          // No credential bytes may be returned by the host protocol.
          if (policy.agentUid === policy.controllerUid) {
            const { admitHostCredentials } = await import("../../src/agent-host/credential-relink")
            await (
              await admitHostCredentials(policy, client)
            )()
          } else {
            expect(
              await asIdentity(
                policy.controllerUid,
                policy.groupGid,
                admissionCode.replaceAll('"codex"', JSON.stringify(client)),
                { SOCKET: socket, CLIENT_MODULE: clientModule },
              ),
            ).toEqual({ admitted: true })
          }
          await checkCredentialAdmission(policy, client)
          expect(await readFile(login.canonical, "utf8")).toBe("synthetic-new-login")
          expect((await lstat(login.benLink)).isSymbolicLink()).toBe(true)
          expect((await lstat(login.agentLink)).isSymbolicLink()).toBe(true)
          expect(
            await lstat(join(policy.root, `${client}.repair.json`)).catch(() => null),
          ).toBeNull()
        } finally {
          await host.close()
          await close()
        }
      },
    )
  }

for (const state of [
  "both changed",
  "wrong link",
  "missing other",
  "older",
  "equal timestamp",
  "hardlink",
  "permissions",
  "wrong owner",
  "journal",
  "staging",
  "pending link",
  "unsafe parent",
  "canonical permissions",
  "canonical missing",
  "empty",
  "oversize",
  "active agent",
  "active controller",
  "admission lease",
] as const) {
  adminTest(
    `the host refuses automatic relink for ${state} without changing credential bytes`,
    async () => {
      const { admitHostCredentials } = await import("../../src/agent-host/credential-relink")
      const { credentialLock } = await import("../../src/agent-host/credentials")
      const { utimes, link } = await import("node:fs/promises")
      const { policy, close } = await fixture()
      const login = policy.claude
      let release: (() => Promise<void>) | undefined
      let child: ReturnType<typeof Bun.spawn> | undefined
      try {
        await utimes(login.canonical, 10, 10)
        await rm(login.benLink)
        await writeFile(login.benLink, "synthetic-new-login", { mode: 0o600 })
        await chown(login.benLink, policy.controllerUid, policy.groupGid)
        if (["both changed", "wrong link", "missing other"].includes(state))
          await rm(login.agentLink)
        if (state === "both changed")
          await writeFile(login.agentLink, "competing-login", { mode: 0o600 })
        if (state === "wrong link") await symlink(login.benLink, login.agentLink)
        if (state === "older" || state === "equal timestamp")
          await utimes(login.benLink, 1, state === "older" ? 1 : 10)
        if (state === "hardlink") await link(login.benLink, `${login.benLink}.copy`)
        if (state === "permissions") await chmod(login.benLink, 0o644)
        if (state === "journal")
          await writeFile(join(policy.root, "claude.repair.json"), "{}", { mode: 0o600 })
        if (state === "staging")
          await writeFile(join(policy.root, "claude.staging"), "competing-login")
        if (state === "pending link")
          await symlink(login.canonical, `${login.benLink}.workflowd-relink`)
        if (state === "unsafe parent") await chmod(join(policy.root, "..", "ben"), 0o777)
        if (state === "canonical permissions") await chmod(login.canonical, 0o666)
        if (state === "canonical missing") await rm(login.canonical)
        if (state === "empty") await writeFile(login.benLink, "")
        if (state === "oversize") await writeFile(login.benLink, "x".repeat(1024 * 1024 + 1))
        const source = await lstat(login.benLink)
        const before = await readFile(login.canonical, "utf8").catch(() => null)
        const effective = { ...policy, consumerExecutables: [] as string[] }
        if (state === "wrong owner") effective.controllerUid = 65533
        if (state === "active agent" || state === "active controller") {
          const uid = state === "active agent" ? policy.agentUid : policy.controllerUid
          const args = ["/bin/sleep", "30"]
          child = Bun.spawn(
            uid === process.getuid!()
              ? args
              : [
                  "/usr/bin/setpriv",
                  "--reuid",
                  String(uid),
                  "--regid",
                  String(policy.groupGid),
                  "--clear-groups",
                  ...args,
                ],
            { stdout: "ignore", stderr: "ignore" },
          )
          const { stat } = await import("node:fs/promises")
          const deadline = Date.now() + 3000
          while ((await stat(`/proc/${child.pid}`)).uid !== uid) {
            if (Date.now() > deadline) throw new Error("fixture UID transition timed out")
            await Bun.sleep(5)
          }
          if (state === "active controller") {
            if (effective.agentUid === effective.controllerUid) effective.agentUid = 65533
            effective.consumerExecutables = ["/bin/sleep"]
          }
        }
        if (state === "admission lease") release = await credentialLock(policy, false)
        await expect(admitHostCredentials(effective, "claude")).rejects.toMatchObject({
          reason: ["active agent", "active controller", "admission lease", "journal"].includes(
            state,
          )
            ? "credential_relink_in_progress"
            : expect.stringMatching(/shared_credential_|credential_relink_in_progress/),
        })
        expect(await readFile(login.canonical, "utf8").catch(() => null)).toBe(before)
        expect((await lstat(login.benLink)).ino).toBe(source.ino)
      } finally {
        await release?.()
        child?.kill()
        if (child) await child.exited
        await close()
      }
    },
  )
}

for (const source of ["auto", "ben"] as const) {
  adminTest(
    `relink ${source} preserves an opposite-side login replaced during import`,
    async () => {
      const { spyOn } = await import("bun:test")
      const filesystem = await import("node:fs/promises")
      const { policy, close } = await fixture()
      await filesystem.utimes(policy.codex.canonical, 1, 1)
      await rm(policy.codex.benLink)
      await writeFile(policy.codex.benLink, "selected-login", { mode: 0o600 })
      await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
      const original = filesystem.rename
      let raced = false
      const race = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
        await original(from, to)
        if (String(from).endsWith("codex.staging")) {
          raced = true
          await rm(policy.codex.agentLink)
          await writeFile(policy.codex.agentLink, "concurrent-login", { mode: 0o600 })
        }
      })
      try {
        await expect(relinkCredentials(policy, "codex", source)).rejects.toMatchObject({
          reason: "shared_credential_diverged",
        })
        expect(raced).toBe(true)
        expect(await readFile(policy.codex.agentLink, "utf8")).toBe("concurrent-login")
        expect((await lstat(policy.codex.agentLink)).isFile()).toBe(true)
        expect((await lstat(join(policy.root, "codex.repair.json"))).isFile()).toBe(true)
      } finally {
        race.mockRestore()
        await close()
      }
    },
  )
}

adminTest("relink caps a source that grows after its size check", async () => {
  const { spyOn } = await import("bun:test")
  const filesystem = await import("node:fs/promises")
  const { policy, close } = await fixture()
  await rm(policy.codex.benLink)
  await writeFile(policy.codex.benLink, "selected-login", { mode: 0o600 })
  await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
  const original = filesystem.open
  const race = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    if (String(path).endsWith("codex.staging"))
      await writeFile(policy.codex.benLink, Buffer.alloc(1024 * 1024 + 1))
    return original(path, flags, mode)
  })
  try {
    await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
      reason: "shared_credential_diverged",
    })
    expect(await readFile(policy.codex.canonical, "utf8")).toBe("synthetic-generation-1")
  } finally {
    race.mockRestore()
    await close()
  }
})

adminTest("relink refuses an active or uncertain unit recorded in host custody", async () => {
  const { agentHostUnitName } = await import("../../src/agent-host/protocol")
  const { policy, close } = await fixture()
  const custodyRoot = join(policy.root, "custody")
  await mkdir(custodyRoot, { mode: 0o700 })
  const launch = {
    custodyRoot,
    ioRoot: policy.root,
    home: policy.root,
    workspaceRoot: policy.root,
    bun: process.execPath,
    worker: "/unused",
    codex: "/unused",
    claude: "/unused",
  }
  try {
    await rm(policy.codex.benLink)
    await writeFile(policy.codex.benLink, "selected-login", { mode: 0o600 })
    await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
    const { createHash } = await import("node:crypto")
    const path = join(custodyRoot, `${createHash("sha256").update("live").digest("hex")}.json`)
    for (const active of [true, false]) {
      await writeFile(
        path,
        JSON.stringify({
          process: {
            runId: "live",
            unit: agentHostUnitName("live"),
            launchId: "launch",
            invocationId: active ? "invocation" : null,
            uid: policy.agentUid,
            pid: 0,
            started: new Date().toISOString(),
            active,
            exitCode: null,
          },
        }),
        { mode: 0o600 },
      )
      await expect(relinkCredentials({ ...policy, launch }, "codex", "ben")).rejects.toMatchObject({
        reason: "credential_relink_in_progress",
      })
      expect(await readFile(policy.codex.canonical, "utf8")).toBe("synthetic-generation-1")
    }
  } finally {
    await close()
  }
})

adminTest("relink swaps back a source replaced after the final path check", async () => {
  const { spyOn } = await import("bun:test")
  const filesystem = await import("node:fs/promises")
  const { policy, close } = await fixture()
  await filesystem.utimes(policy.codex.canonical, 1, 1)
  await rm(policy.codex.benLink)
  await writeFile(policy.codex.benLink, "selected-login", { mode: 0o600 })
  await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
  const otherInode = (await lstat(policy.codex.agentLink)).ino
  const original = filesystem.readlink
  let raced = false
  const race = spyOn(filesystem, "readlink").mockImplementation(
    new Proxy(original, {
      async apply(target, _receiver, args: unknown[]) {
        const path = args[0]
        if (typeof path !== "string" || args.length !== 1)
          throw new Error("unexpected readlink arguments")
        const result = await target(path)
        const info = await lstat(path).catch(() => null)
        if (
          !raced &&
          info?.ino === otherInode &&
          (await lstat(`${policy.codex.benLink}.workflowd-relink`).catch(() => null))
        ) {
          raced = true
          const fresh = `${policy.codex.benLink}.login`
          await writeFile(fresh, "concurrent-login", { mode: 0o600 })
          await filesystem.rename(fresh, policy.codex.benLink)
        }
        return result
      },
    }),
  )
  try {
    await expect(relinkCredentials(policy, "codex", "auto")).rejects.toMatchObject({
      reason: "shared_credential_diverged",
    })
    expect(raced).toBe(true)
    expect((await lstat(policy.codex.benLink)).isFile()).toBe(true)
    expect(await readFile(policy.codex.benLink, "utf8")).toBe("concurrent-login")
    expect((await lstat(join(policy.root, "codex.repair.json"))).isFile()).toBe(true)
  } finally {
    race.mockRestore()
    await close()
  }
})

adminTest(
  "relink preserves an unvalidated displaced login left by an interrupted exchange",
  async () => {
    const { policy, close } = await fixture()
    try {
      await rm(policy.codex.benLink)
      await writeFile(policy.codex.benLink, "selected-login", { mode: 0o600 })
      await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
      const displaced = `${policy.codex.benLink}.workflowd-relink`
      await writeFile(displaced, "concurrent-login", { mode: 0o600 })
      await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
        reason: "shared_credential_diverged",
      })
      expect(await readFile(displaced, "utf8")).toBe("concurrent-login")
      expect((await lstat(join(policy.root, "codex.repair.json"))).isFile()).toBe(true)
    } finally {
      await close()
    }
  },
)

adminTest(
  "relink preserves a source rewritten in place by a concurrent watcher",
  async () => {
    const { Worker } = await import("node:worker_threads")
    const { spyOn } = await import("bun:test")
    const filesystem = await import("node:fs/promises")
    const { policy, close } = await fixture()
    await rm(policy.codex.benLink)
    await writeFile(policy.codex.benLink, "selected-login", { mode: 0o600 })
    await chown(policy.codex.benLink, policy.controllerUid, policy.groupGid)
    const before = await lstat(policy.codex.benLink)
    const state = new Int32Array(new SharedArrayBuffer(4))
    const watcher = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const original = fs.statSync(workerData.canonical).ino;
    const state = new Int32Array(workerData.state);
    Atomics.store(state, 0, 1);
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) throw new Error("canonical exchange not observed");
      if (fs.statSync(workerData.canonical).ino === original) return;
      clearInterval(timer);
      fs.writeFileSync(workerData.source, "concurrent-new");
      Atomics.store(state, 0, 2);
    }, 1);
  `,
      {
        eval: true,
        workerData: {
          canonical: policy.codex.canonical,
          source: policy.codex.benLink,
          state: state.buffer,
        },
      },
    )
    const waitFor = async (value: number) => {
      const deadline = Date.now() + 6000
      while (Atomics.load(state, 0) < value) {
        if (Date.now() > deadline) throw new Error("watcher did not reach barrier")
        await Bun.sleep(1)
      }
    }
    await waitFor(1)
    const original = filesystem.rename
    const barrier = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      await original(from, to)
      if (String(from).endsWith("codex.staging")) await waitFor(2)
    })
    try {
      await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
        reason: "shared_credential_diverged",
      })
      expect((await lstat(policy.codex.benLink)).ino).toBe(before.ino)
      expect(await readFile(policy.codex.benLink, "utf8")).toBe("concurrent-new")
      const journal = JSON.parse(await readFile(join(policy.root, "codex.repair.json"), "utf8"))
      expect(journal).toMatchObject({
        sourceCtimeMs: before.ctimeMs,
        sourceMtimeMs: before.mtimeMs,
        sourceSize: before.size,
      })
    } finally {
      barrier.mockRestore()
      void watcher.terminate()
      await close()
    }
  },
  10000,
)
