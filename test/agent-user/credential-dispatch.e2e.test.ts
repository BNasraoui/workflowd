import { expect, test } from "bun:test"
import type { Schema } from "effect"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCredentialAdmission } from "../../src/agent-host/credentials"
import { relinkCredentials } from "../../src/agent-host/credential-relink"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "credential-dispatch-"))
  const store = join(root, "store")
  const benHome = join(root, "ben")
  const agentHome = join(root, "agent")
  for (const directory of [store, benHome, agentHome]) await mkdir(directory, { mode: 0o710 })
  const canonical = join(store, "auth.json")
  const benLink = join(benHome, "auth.json")
  const agentLink = join(agentHome, "auth.json")
  await writeFile(canonical, "synthetic-generation-1", { mode: 0o660 })
  await chmod(canonical, 0o660)
  await symlink(canonical, benLink)
  await symlink(canonical, agentLink)
  const policy = {
    root: store,
    ownerUid: process.getuid!(),
    groupGid: process.getgid!(),
    controllerUid: process.getuid!(),
    agentUid: process.getuid!(),
    codex: { canonical, benLink, agentLink },
    claude: { canonical, benLink, agentLink },
    consumerExecutables: [],
  }
  return { policy, close: () => rm(root, { recursive: true, force: true }) }
}

test("a replaced login refuses even with identical bytes; explicit relink restores both links", async () => {
  const { policy, close } = await fixture()
  try {
    await checkCredentialAdmission(policy, "codex")
    await rm(policy.codex.benLink)
    await writeFile(policy.codex.benLink, "synthetic-generation-1", { mode: 0o600 })
    await expect(checkCredentialAdmission(policy, "codex")).rejects.toMatchObject({
      reason: "shared_credential_diverged",
    })
    await writeFile(policy.codex.benLink, "synthetic-generation-2")
    await relinkCredentials(policy, "codex", "ben")
    await checkCredentialAdmission(policy, "codex")
    expect((await lstat(policy.codex.benLink)).isSymbolicLink()).toBe(true)
    expect((await lstat(policy.codex.agentLink)).isSymbolicLink()).toBe(true)
    expect(await readFile(policy.codex.agentLink, "utf8")).toBe("synthetic-generation-2")
    expect((await lstat(policy.codex.canonical)).mode & 0o777).toBe(0o660)
  } finally {
    await close()
  }
})

test("missing links, permission loss, competing replacements and interrupted repair stay refused", async () => {
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
})

test("an admission lease excludes administrative repair until dispatch handoff", async () => {
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
    await relinkCredentials(policy, "codex", "ben")
  } finally {
    await close()
  }
})

test("interrupted repair can resume from the selected source without choosing by mtime", async () => {
  const { policy, close } = await fixture()
  try {
    await rm(policy.codex.benLink)
    await writeFile(policy.codex.benLink, "synthetic-generation-2", { mode: 0o600 })
    const source = await lstat(policy.codex.benLink)
    await writeFile(
      join(policy.root, "codex.repair.json"),
      JSON.stringify({
        client: "codex",
        source: "ben",
        sourceDevice: source.dev,
        sourceInode: source.ino,
      }),
      { mode: 0o600 },
    )
    await relinkCredentials(policy, "codex", "ben")
    await checkCredentialAdmission(policy, "codex")
    expect(await readFile(policy.codex.agentLink, "utf8")).toBe("synthetic-generation-2")
  } finally {
    await close()
  }
})

for (const state of ["original", "removed", "linked", "replaced"] as const) {
  test(`repair after canonical replacement handles a ${state} source without importing it again`, async () => {
    const { policy, close } = await fixture()
    try {
      const { canonical, benLink, agentLink } = policy.codex
      await rm(benLink)
      await writeFile(benLink, "synthetic-generation-2", { mode: 0o600 })
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
        await relinkCredentials(policy, "codex", "ben")
        await checkCredentialAdmission(policy, "codex")
        expect((await lstat(canonical)).ino).toBe(staged.ino)
        expect(await readFile(agentLink, "utf8")).toBe("synthetic-generation-2")
      }
    } finally {
      await close()
    }
  })
}

test("the host authenticates peer UID and checks again after successful preflight", async () => {
  const { serveCredentialHost } = await import("../../src/agent-host/server")
  const { acquireCredentialAdmission } = await import("../../src/agent-host/client")
  const { policy, close } = await fixture()
  const socket = join(policy.root, "host.sock")
  const host = await serveCredentialHost(socket, policy)
  try {
    const release = await acquireCredentialAdmission(socket, "codex")
    await expect(relinkCredentials(policy, "codex", "ben")).rejects.toMatchObject({
      reason: "credential_relink_in_progress",
    })
    await release()
    await rm(policy.codex.agentLink)
    await expect(acquireCredentialAdmission(socket, "codex")).rejects.toMatchObject({
      reason: "shared_credential_link_broken",
    })
  } finally {
    await host.close()
    await close()
  }
})

test("refused CLI spawn starts no process and retains its typed reason", async () => {
  const { Effect } = await import("effect")
  const { guardCliCredentials } = await import("../../src/agent-host/client")
  const { credentialReason } = await import("../../src/agent-host/protocol")
  const { serveCredentialHost } = await import("../../src/agent-host/server")
  const { policy, close } = await fixture()
  const socket = join(policy.root, "host.sock")
  const host = await serveCredentialHost(socket, policy)
  let starts = 0
  const cli = guardCliCredentials(
    {
      ownership: "resident-thread",
      preflight: Effect.void,
      cancelRun: () => Effect.void,
      spawn: () =>
        Effect.suspend(() => {
          starts++
          return Effect.die("unexpected spawn")
        }),
    },
    socket,
    "codex",
  )
  try {
    await Effect.runPromise(cli.preflight)
    await rm(policy.codex.benLink)
    await writeFile(policy.codex.benLink, "replacement", { mode: 0o600 })
    const result = await Effect.runPromise(
      cli
        .spawn({ runId: "test", directory: policy.root, prompt: "test", model: null })
        .pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(credentialReason(result.failure)).toBe("shared_credential_diverged")
    expect(starts).toBe(0)
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
