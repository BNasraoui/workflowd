import { expect, test } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxDispatch, type SandboxDispatchPort } from "../../src/sandbox/dispatch"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { realpath, writeFile, mkdtemp, rm } from "node:fs/promises"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { WorkflowStoreLive } from "../../src/store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import {
  dispatchRunnerFixture,
  sandboxGithubFixture,
  sandboxModelFixture,
  sandboxIngressFixtureLayer,
} from "./harness"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { readSandboxEndpoint, stopSandboxOpenCode } from "../../src/sandbox/opencode"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import {
  OpenCodeCompletionProvider,
  runOpenCodeCompletionSourceIteration,
} from "../../src/kernel/opencode-completion-source"
import {
  defaultState,
  makeLayer,
  makeProvider,
  register,
  submission,
  worktrees,
} from "../kernel/agent-run-ingress-harness"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
}

test("sandbox aliases fail closed before local worktrees or shared provider sessions", async () => {
  const created: Array<{ repository: string; directory: string; branch: string }> = []
  const state = defaultState()
  const layer = makeLayer(makeProvider(state), worktrees(created), undefined, {
    sandboxRepositories: [policy],
  })
  const result = await Effect.runPromise(
    register(submission).pipe(Effect.provide(layer), Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(created).toEqual([])
  expect(state.created).toEqual([])
})

test("sandbox aliases refuse a native CLI executor before spawning", async () => {
  const created: Array<{ repository: string; directory: string; branch: string }> = []
  const layer = makeLayer(makeProvider(defaultState()), worktrees(created), undefined, {
    sandboxRepositories: [policy],
  })
  const result = await Effect.runPromise(
    register({ ...submission, route: "scan" }).pipe(Effect.provide(layer), Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(created).toEqual([])
})

test("sandbox cancellation retains the run and caller mailbox until cleanup confirms release", async () => {
  const state = defaultState()
  const cancelled: string[] = []
  const sandbox: SandboxDispatchPort = {
    launch: () =>
      Effect.succeed({ nativeSessionId: "ses_child", endpoint: "http://127.0.0.1:12345" }),
    owns: () => Effect.succeed(true),
    cancel: (run) =>
      Effect.sync(() => {
        cancelled.push(run.runId)
      }),
    observe: () => Effect.void,
    iteration: Effect.void,
    heartbeat: Effect.void,
    provider: () => Effect.die("unused"),
  }
  const layer = makeLayer(makeProvider(state), worktrees([]), undefined, {
    sandboxRepositories: [policy],
  }).pipe(Layer.provideMerge(Layer.succeed(SandboxDispatch, sandbox)))
  await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register(submission)
      const ingress = yield* AgentRunIngress
      yield* ingress.cancel(receipt.runId, new Date())
      const runs = yield* AgentRunStore
      const sql = yield* SqlClient.SqlClient
      expect(cancelled).toEqual([receipt.runId])
      expect(state.aborted).toEqual([])
      expect((yield* runs.read(receipt.runId))?.state).toBe("verified")
      expect(
        yield* sql`SELECT id FROM resident_inbox WHERE id=${"agent-run-end-" + receipt.runId}`,
      ).toHaveLength(0)
    }).pipe(Effect.provide(layer)),
  )
})

test("sandbox parent watches consume durable terminal mailboxes and fence stale generations", async () => {
  const state = defaultState()
  state.telemetry.set("ses_parent", {
    directory: "/fixture-parent",
    outputTokens: 1,
    updatedAtMs: Date.now(),
    idle: false,
  })
  const sandbox = makeSandboxStore.pipe(
    Effect.map(
      (store) =>
        ({
          launch: (run) =>
            Effect.gen(function* () {
              yield* store.request({
                runId: run.runId,
                leaseId: "lease-1",
                policy,
                sourceSha: "b".repeat(40),
                now: Date.now(),
              })
              yield* store.beginStart(run.runId)
              yield* store.recordRun(run.runId, 41, 1)
              yield* store.bind(run.runId, 41, 1, {
                leaseId: "lease-1",
                peerId: "fixture",
                address: "127.0.0.1",
                port: 22,
                repositoryPath: "/workspace/repository",
                knownHostsFile: "/tmp/key",
                identityFile: "/dev/null",
              })
              yield* store.attachUnit(run.runId, "workflowd-sandbox-lease-1", "a".repeat(32))
              yield* store.attachSession(run.runId, "ses_child")
              return { nativeSessionId: "ses_child", endpoint: "http://127.0.0.1:12345" }
            }).pipe(Effect.orDie),
          owns: () => Effect.succeed(true),
          cancel: () => Effect.void,
          observe: () => Effect.void,
          iteration: Effect.void,
          heartbeat: Effect.void,
          provider: () => Effect.die("unused"),
        }) satisfies SandboxDispatchPort,
    ),
  )
  const layer = await sandboxIngressFixtureLayer(makeProvider(state), sandbox, policy)
  const observe = runOpenCodeCompletionSourceIteration({
    owningHostId: "mint",
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    providerVersion: 1,
    observationTimeoutMs: 100,
    now: () => new Date(),
  }).pipe(
    Effect.provideService(OpenCodeCompletionProvider, {
      sessionExists: async () => {
        throw new Error("Sandbox leaked into shared server polling")
      },
      sessionFinished: async () => {
        throw new Error("Sandbox leaked into shared server polling")
      },
      listMessages: async () => {
        throw new Error("Sandbox leaked into shared server polling")
      },
      subscribeEvents: async () => {
        throw new Error("Sandbox leaked into shared server polling")
      },
    }),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register({
        ...submission,
        parentSessionId: "ses_parent",
        resumePrompt: "Continue",
      })
      const store = yield* makeSandboxStore
      yield* store.request({
        runId: receipt.runId,
        leaseId: "lease-1",
        policy,
        sourceSha: "b".repeat(40),
        now: Date.now(),
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE sandbox_leases SET session_id=${receipt.nativeSessionId},state='releasing' WHERE run_id=${receipt.runId}`
      expect((yield* observe).status).toBe("idle")
      const runs = yield* AgentRunStore
      expect((yield* Effect.result(store.confirmReleased(receipt.runId)))._tag).toBe("Failure")
      const [cleanup] = yield* store.cleanupRuns()
      if (!cleanup) throw new Error("Missing sandbox cleanup custody")
      yield* store.cleanupState(cleanup, "terminated")
      yield* store.finishCleanup(cleanup, Effect.void)
      yield* runs.complete({
        runId: receipt.runId,
        finalMessage: "saved sandbox answer",
        now: new Date(),
      })
      yield* sql`UPDATE kernel_agent_completion_watches SET child_session_generation=child_session_generation+1 WHERE child_session_id=${receipt.sessionId}`
      expect((yield* observe).status).toBe("idle")
      yield* sql`UPDATE kernel_agent_completion_watches SET child_session_generation=child_session_generation-1 WHERE child_session_id=${receipt.sessionId}`
      expect((yield* observe).status).toBe("completed")
    }).pipe(Effect.provide(layer)),
  )
})

test("sandbox dispatch keeps mint workspace custody and prompts without worker mailbox instructions", async () => {
  const created: Array<{ repository: string; directory: string; branch: string }> = []
  const state = defaultState()
  const launches: string[] = []
  const sandbox: SandboxDispatchPort = {
    launch: (run) =>
      Effect.sync(() => {
        launches.push(run.runId)
        return { nativeSessionId: "ses_child", endpoint: "http://127.0.0.1:12345" }
      }),
    owns: () => Effect.succeed(true),
    cancel: () => Effect.void,
    observe: () => Effect.void,
    iteration: Effect.void,
    heartbeat: Effect.void,
    provider: () => Effect.die("unused"),
  }
  const layer = makeLayer(makeProvider(state), worktrees(created), undefined, {
    sandboxRepositories: [policy],
  }).pipe(Layer.provideMerge(Layer.succeed(SandboxDispatch, sandbox)))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register(submission)
      const sql = yield* SqlClient.SqlClient
      const resources =
        yield* sql`SELECT kind, owning_host_id, absolute_path FROM kernel_working_resources WHERE resource_id=(SELECT resource_id FROM kernel_sessions WHERE session_id=${receipt.sessionId})`
      const sessions =
        yield* sql`SELECT endpoint_identity,server_id FROM kernel_sessions WHERE session_id=${receipt.sessionId}`
      return { receipt, resources, sessions }
    }).pipe(Effect.provide(layer)),
  )
  expect(launches).toEqual([result.receipt.runId])
  expect(created).toEqual([])
  expect(state.created).toEqual([])
  expect(state.prompted).toEqual([{ sessionID: "ses_child", text: submission.prompt }])
  expect(result.resources[0]).toMatchObject({ kind: "workspace", owning_host_id: "mint" })
  expect(result.sessions[0]).toMatchObject({ endpoint_identity: "http://127.0.0.1:12345" })
})

test("dedicated provider authenticates only its endpoint and bounds response bodies", async () => {
  const { createSandboxProvider } = await import("../../src/sandbox/provider")
  let oversized = false
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.headers.get("authorization") ?? "")
      if (oversized) return new Response("x".repeat(1048577))
      return Response.json({
        data: {
          id: "ses_fixture",
          projectID: "fixture",
          cost: 0,
          tokens: { input: 0, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          location: { directory: "/control" },
        },
      })
    },
  })
  try {
    const provider = createSandboxProvider({ url: server.url.toString(), password: "fixture" })
    expect(
      await Effect.runPromise(provider.sessionTelemetry({ sessionID: "ses_fixture" })),
    ).toMatchObject({ outputTokens: 7, directory: "/control" })
    expect(requests).toEqual([`Basic ${Buffer.from("opencode:fixture").toString("base64")}`])
    oversized = true
    expect(
      (
        await Effect.runPromise(
          Effect.result(provider.sessionTelemetry({ sessionID: "ses_fixture" })),
        )
      )._tag,
    ).toBe("Failure")
  } finally {
    await server.stop(true)
  }
})

test("real dedicated session captures an inert patch and releases before publishing its terminal mailbox", async () => {
  const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
  const runner = await dispatchRunnerFixture()
  const fixture = await sandboxGithubFixture(policy, runner.name)
  const model = await sandboxModelFixture()
  const directory = join(runner.root, "control")
  const authFile = join(runner.root, "auth.json")
  await writeFile(
    authFile,
    JSON.stringify({ openai: { type: "api", key: "fixture-model-canary" } }),
    { mode: 0o600 },
  )
  const base = WorkflowStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(runner.root, "coordinator.sqlite") })),
  )
  const stores = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
    Layer.provideMerge(base),
  )
  try {
    // The lease acquisition boundary is proven separately against the same real SSH fixture.
    // This starts from its ready custody and exercises the actual session coordinator.
    await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* AgentRunStore
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github, directory)
        const service = yield* makeSandboxDispatch({
          policies: [policy],
          github,
          leases,
          binary: yield* Effect.tryPromise(() => realpath(Bun.which("opencode2")!)),
          authFile,
          providers: model.providers,
        })
        yield* runs.create({
          runId: "run-1",
          route: "sandbox",
          providerId: "openai",
          modelId: "gpt-6-astra-fixture",
          agent: "sandbox",
          repository: "workflowd",
          directory,
          prompt: "Write a proof file",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 1,
          createdAt: new Date(),
        })
        yield* runs.claimSpawn({ runId: "run-1", now: new Date() })
        yield* store.request({
          runId: "run-1",
          leaseId: runner.name,
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("run-1")
        yield* store.recordRun("run-1", 41, 1)
        yield* store.bind("run-1", 41, 1, runner.transport)
        const run = (yield* runs.read("run-1"))!
        const launched = yield* service.launch(run, {
          providerID: "openai",
          modelID: "gpt-6-astra-fixture",
        })
        const sessions = yield* KernelSessionStore
        yield* sessions.registerResource({
          resourceId: "resource",
          owningHostId: "mint",
          absolutePath: directory,
          kind: "workspace",
          createdAt: new Date(),
        })
        yield* sessions.registerSession({
          sessionId: `opencode-session-${launched.nativeSessionId}`,
          nativeSessionId: launched.nativeSessionId,
          resourceId: "resource",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "sandbox",
          serverId: "sandbox",
          endpointAlias: "sandbox",
          endpointIdentity: launched.endpoint,
          owningHostId: "mint",
          createdAt: new Date(),
        })
        yield* runs.markSpawned({
          runId: "run-1",
          nativeSessionId: launched.nativeSessionId,
          sessionId: `opencode-session-${launched.nativeSessionId}`,
          resourceId: "resource",
          now: new Date(),
        })
        const provider = yield* service.provider(launched.nativeSessionId)
        yield* provider.promptSession({
          sessionID: launched.nativeSessionId,
          directory,
          agent: "sandbox",
          model: { providerID: "openai", modelID: "gpt-6-astra-fixture" },
          text: "Write a proof file",
        })
        yield* runs.markVerified({ runId: "run-1", outputTokens: 1, now: new Date() })
        const active = (yield* runs.read("run-1"))!
        const finished = yield* provider
          .sessionTelemetry({ sessionID: launched.nativeSessionId })
          .pipe(
            Effect.repeat({
              while: (state) => !state?.idle,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("120 seconds"),
          )
        expect(finished?.finalMessage).toBe("sandbox dispatch complete")
        yield* service.observe(active)
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT id FROM resident_inbox WHERE id='agent-run-end-run-1'`,
        ).toHaveLength(0)
        expect((yield* store.read("run-1"))?.state).toBe("releasing")
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* service.iteration
        expect((yield* runs.read("run-1"))?.state).toBe("completed")
        const mail = yield* sql`SELECT prompt FROM resident_inbox WHERE id='agent-run-end-run-1'`
        expect(String(mail[0]?.prompt)).toContain("sandbox dispatch complete")
        expect(
          yield* Effect.tryPromise(() => Bun.file(join(directory, "result.patch")).text()),
        ).toContain("dispatch-proof")
        expect(
          (yield* Effect.tryPromise(() =>
            Bun.file(join(directory, "result.patch")).text(),
          )).endsWith("\n"),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() => Bun.file(join(directory, "proof.txt")).exists()),
        ).toBe(false)
        expect((yield* store.read("run-1"))?.state).toBe("released")
      }).pipe(Effect.provide(stores)),
    )
  } finally {
    if (await Bun.file(join(directory, "endpoint.json")).exists())
      await stopSandboxOpenCode(await readSandboxEndpoint(directory))
    await model.close()
    await fixture.close()
    await runner.close()
  }
}, 180000)

for (const reason of ["missing endpoint", "deadline", "cancel"])
  test(`sandbox ${reason} retains artifacts and confirms release before its terminal mailbox`, async () => {
    const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
    const directory = await mkdtemp(join(tmpdir(), "sandbox-terminal-"))
    const fixture = await sandboxGithubFixture(policy)
    const base = WorkflowStoreLive.pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: join(directory, "custody.sqlite") })),
    )
    const layer = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
      Layer.provideMerge(base),
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* AgentRunStore
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const bytes = new Uint8Array([0xff, 0, 32, 10])
          const leases = yield* makeSandboxLeaseService(github, directory, async () => bytes)
          const service = yield* makeSandboxDispatch({
            policies: [policy],
            github,
            leases,
            binary: process.execPath,
            authFile: "/unused",
            providers: {},
          })
          yield* runs.create({
            runId: "run-1",
            route: "sandbox",
            providerId: "openai",
            modelId: "fixture",
            agent: "sandbox",
            repository: policy.alias,
            directory,
            prompt: "Task",
            promptSha256: "a".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          yield* runs.claimSpawn({ runId: "run-1", now: new Date() })
          const sessions = yield* KernelSessionStore
          yield* sessions.registerResource({
            resourceId: "resource",
            owningHostId: "mint",
            absolutePath: directory,
            kind: "workspace",
            createdAt: new Date(),
          })
          yield* sessions.registerSession({
            sessionId: "session",
            nativeSessionId: "ses_child",
            resourceId: "resource",
            providerKind: "opencode",
            providerVersion: 1,
            providerId: "sandbox",
            serverId: "sandbox:ses_child",
            endpointAlias: "sandbox",
            endpointIdentity: "http://127.0.0.1:1",
            owningHostId: "mint",
            createdAt: new Date(),
          })
          yield* runs.markSpawned({
            runId: "run-1",
            nativeSessionId: "ses_child",
            sessionId: "session",
            resourceId: "resource",
            now: new Date(),
          })
          yield* runs.markVerified({ runId: "run-1", outputTokens: 1, now: new Date() })
          yield* store.request({
            runId: "run-1",
            leaseId: "lease-1",
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now() - (reason === "deadline" ? 286 * 60000 : 0),
          })
          yield* store.beginStart("run-1")
          yield* store.recordRun("run-1", 41, 1)
          yield* store.bind("run-1", 41, 1, {
            leaseId: "lease-1",
            peerId: "peer",
            address: "127.0.0.1",
            port: 22,
            repositoryPath: "/workspace/repository",
            knownHostsFile: "/tmp/key",
            identityFile: "/dev/null",
          })
          const run = (yield* runs.read("run-1"))!
          expect(
            (yield* Effect.result(reason === "cancel" ? service.cancel(run) : service.observe(run)))
              ._tag,
          ).toBe("Success")
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT * FROM resident_inbox`).toEqual([])
          expect((yield* store.read("run-1"))?.state).toBe("releasing")
          expect(
            new Uint8Array(
              yield* Effect.tryPromise(() =>
                Bun.file(join(directory, "result.patch")).arrayBuffer(),
              ),
            ),
          ).toEqual(bytes)
          fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
          yield* service.iteration
          expect((yield* store.read("run-1"))?.state).toBe("released")
          expect((yield* runs.read("run-1"))?.state).toBe(
            reason === "cancel" ? "cancelled" : "operator_required",
          )
          expect(yield* sql`SELECT * FROM resident_inbox`).toHaveLength(1)
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await fixture.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
