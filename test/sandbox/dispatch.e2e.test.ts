import { Session } from "@opencode-ai/client/effect"
import { expect, test } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  SandboxDispatch,
  makeSandboxDispatch,
  type SandboxDispatchPort,
} from "../../src/sandbox/dispatch"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { WorkflowStoreLive } from "../../src/store"
import { makeSandboxStore, SandboxError } from "../../src/sandbox/store"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { dispatchRunnerFixture, sandboxGithubFixture, sandboxIngressFixtureLayer } from "./harness"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import {
  sandboxBridgeName,
  readSandboxBinding,
  bindingDirectory,
  assertBridgeBinding,
  writeSandboxBinding,
} from "../../src/sandbox/binding"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentWaitIngress } from "../../src/kernel/agent-wait-ingress"
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

const sandboxRun = (directory: string, modelId: string, prompt: string) => ({
  runId: "run-1",
  route: "sandbox",
  providerId: "openai",
  modelId,
  agent: "sandbox",
  repository: policy.alias,
  directory,
  prompt,
  promptSha256: "a".repeat(64),
  parentSessionId: null,
  resumePrompt: null,
  maxAttempts: 1,
  createdAt: new Date(),
})

test.each(["before-ref", "without-run", "late-run"])(
  "no observed Actions run produces a durable operator mailbox and retains custody (%s)",
  async (mode) => {
    const shared = await sharedOpenCodeFixture("no-run-mailbox")
    const fixture = await sandboxGithubFixture(policy)
    fixture.listRuns([])
    const directory = join(shared.root, "no-run")
    const stores = AgentRunStoreLive.pipe(
      Layer.provideMerge(
        WorkflowStoreLive.pipe(
          Layer.provideMerge(SqliteClient.layer({ filename: join(shared.root, "custody.sqlite") })),
        ),
      ),
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* AgentRunStore
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const leases = yield* makeSandboxLeaseService(github)
          const service = yield* makeSandboxDispatch({
            policies: [policy],
            github,
            leases,
            executor: shared.executor,
            client: shared.client,
            executorId: "opencode:opencode-primary",
            endpointIdentity: shared.url,
          })
          yield* runs.create(
            sandboxRun(directory, "gpt-6-astra-fixture", "Cancelled before startup"),
          )
          yield* runs.claimSpawn({ runId: "run-1", now: new Date() })
          yield* store.request({
            runId: "run-1",
            leaseId: "lease-1",
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          if (mode !== "before-ref") yield* leases.acquire("run-1")
          yield* service.cancel((yield* runs.read("run-1"))!)
          expect((yield* runs.read("run-1"))?.state).toBe("operator_required")
          expect((yield* store.read("run-1"))?.state).toBe("operator_required")
          const sql = yield* SqlClient.SqlClient
          const mailbox =
            yield* sql`SELECT prompt FROM resident_inbox WHERE id='agent-run-end-run-1'`
          expect(mailbox).toHaveLength(1)
          expect(String(mailbox[0]?.prompt)).toContain("Actions run unobserved")
          expect(String(mailbox[0]?.prompt)).toContain("refs/heads/workflowd/leases/lease-1")
          const restarted = yield* makeSandboxDispatch({
            policies: [policy],
            github,
            leases,
            executor: shared.executor,
            client: shared.client,
            executorId: "opencode:opencode-primary",
            endpointIdentity: shared.url,
          })
          if (mode === "late-run") {
            fixture.listRuns([{}])
            yield* restarted.iteration
            expect(fixture.cancellations).toContain(41)
            fixture.listRuns([])
            fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
            yield* restarted.iteration
            expect((yield* store.read("run-1"))?.state).toBe("released")
          } else {
            yield* restarted.iteration
            expect((yield* store.read("run-1"))?.state).toBe("operator_required")
          }
          expect(
            yield* sql`SELECT prompt FROM resident_inbox WHERE id='agent-run-end-run-1'`,
          ).toEqual(mailbox)
          const response = yield* Effect.tryPromise(() =>
            fetch(
              `${fixture.apiUrl}repos/${policy.repository}/git/ref/heads/workflowd/leases/lease-1`,
              { headers: { Authorization: "Bearer fixture-token" } },
            ),
          )
          expect(response.status).toBe(404)
          expect(fixture.refCreates).toBe(mode === "before-ref" ? 0 : 1)
        }).pipe(Effect.provide(stores)),
      )
    } finally {
      await fixture.close()
      await shared.close()
    }
  },
  30000,
)

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
  state.providers = ["openai"]
  state.models = [{ providerID: "openai", id: "gpt-6-astra-fixture" }]
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
      // Replay historical dedicated custody through the real wait/store path.
      yield* sql`UPDATE kernel_sessions SET server_id='sandbox:ses_child', endpoint_alias='sandbox',
        endpoint_identity='http://127.0.0.1:12345' WHERE session_id=${receipt.sessionId}`
      const waits = yield* AgentWaitIngress
      const legacyInput = {
        childSessionId: receipt.sessionId,
        parentSessionId: "opencode-session-ses_parent",
        resumePrompt: "Resume historical sandbox",
      }
      const legacy = yield* waits.register(legacyInput, new Date())
      expect(legacy.status).toBe("registered")
      const [watch] = yield* sql`SELECT server_id,endpoint_alias,endpoint_identity
        FROM kernel_agent_completion_watches WHERE instance_id=${legacy.instanceId}`
      expect(watch).toMatchObject({
        server_id: "sandbox:ses_child",
        endpoint_alias: "sandbox",
        endpoint_identity: "http://127.0.0.1:12345",
      })
      yield* sql`UPDATE sandbox_leases SET invocation=NULL WHERE run_id=${receipt.runId}`
      expect((yield* Effect.result(waits.register(legacyInput, new Date())))._tag).toBe("Failure")
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
      const runs = yield* AgentRunStore
      expect((yield* runs.read(receipt.runId))?.agent).toBe("sandbox")
      return { receipt, resources, sessions }
    }).pipe(Effect.provide(layer)),
  )
  expect(launches).toEqual([result.receipt.runId])
  expect(created).toEqual([])
  expect(state.created).toEqual([])
  expect(state.prompted).toEqual([{ sessionID: "ses_child", text: submission.prompt }])
  expect(result.resources[0]).toMatchObject({ kind: "workspace", owning_host_id: "mint" })
  expect(result.sessions[0]).toMatchObject({
    endpoint_identity: "http://127.0.0.1:4096",
    server_id: "opencode-primary",
  })
})

test("shared executor session captures an inert patch and releases before publishing its terminal mailbox", async () => {
  const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
  const runner = await dispatchRunnerFixture()
  const fixture = await sandboxGithubFixture(policy, runner.name)
  const shared = await sharedOpenCodeFixture("dispatch")
  const directory = join(runner.root, "control")
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
          executor: {
            ...shared.executor,
            createSession: (input) =>
              Effect.gen(function* () {
                expect(input.id).toBeDefined()
                const reservation = yield* store.bySession(input.id ?? "")
                expect(reservation?.run_id).toBe("run-1")
                expect(reservation?.unit).toBeNull()
                const binding = yield* Effect.tryPromise(() => readSandboxBinding(input.directory))
                expect(binding.state).toBe("reserved")
                expect(binding.sessionId).toBe(input.id ?? "")
                return yield* shared.executor.createSession(input)
              }).pipe(Effect.orDie),
          },
          client: shared.client,
          executorId: "opencode:opencode-primary",
          endpointIdentity: shared.url,
        })
        yield* runs.create(sandboxRun(directory, "gpt-6-astra-fixture", "Write a proof file"))
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
          endpointIdentity: shared.url,
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
        const binding = yield* Effect.tryPromise(() => readSandboxBinding(directory))
        expect(binding).toMatchObject({
          state: "active",
          executorId: "opencode:opencode-primary",
          endpointIdentity: shared.url,
          repositoryId: policy.repositoryId,
          sourceSha: "b".repeat(40),
        })
        const prompt = {
          sessionID: launched.nativeSessionId,
          directory,
          agent: "sandbox",
          model: { providerID: "openai", modelID: "gpt-6-astra-fixture" },
          text: "Must stay confined",
        }
        for (const mutation of [
          { agent: "build" },
          { directory: shared.root },
          { sessionID: "ses_foreign" },
        ]) {
          expect(
            (yield* Effect.result(provider.promptSession({ ...prompt, ...mutation })))._tag,
          ).toBe("Failure")
        }
        yield* Effect.tryPromise(() =>
          assertBridgeBinding(join(bindingDirectory(directory), "binding.json"), runner.transport),
        )
        yield* Effect.tryPromise(async () => {
          await expect(
            assertBridgeBinding(join(bindingDirectory(directory), "binding.json"), {
              ...runner.transport,
              leaseId: "foreign",
            }),
          ).rejects.toThrow("different transport")
        })
        shared.script(
          [
            {
              name: "execute",
              arguments: JSON.stringify({
                code: `const env = JSON.parse(await tools["${sandboxBridgeName(runner.name)}"].environment_create({ environment_source: "/workspace/repository", title: "Dispatch fixture" })); return await tools["${sandboxBridgeName(runner.name)}"].environment_run_cmd({environment_source: "/workspace/repository", environment_id: env.id, command: "printf dispatch-proof > proof.txt"});`,
              }),
            },
          ],
          "sandbox dispatch complete",
        )
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
        expect((yield* Effect.tryPromise(() => readSandboxBinding(directory))).state).toBe(
          "revoked",
        )
        expect((yield* Effect.result(provider.promptSession(prompt)))._tag).toBe("Failure")
        yield* Effect.tryPromise(async () => {
          await expect(writeSandboxBinding(binding)).rejects.toThrow("revoked")
          await expect(
            assertBridgeBinding(
              join(bindingDirectory(directory), "binding.json"),
              runner.transport,
            ),
          ).rejects.toThrow("revoked")
        })
      }).pipe(Effect.provide(stores)),
    )
  } finally {
    await shared.close()
    await rm(bindingDirectory(directory), { recursive: true, force: true })
    await fixture.close()
    await runner.close()
  }
}, 180000)

for (const reason of ["missing endpoint", "deadline", "cancel"])
  test(`sandbox ${reason} retains artifacts and confirms release before its terminal mailbox`, async () => {
    const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
    const directory = await mkdtemp(join(tmpdir(), "sandbox-terminal-"))
    const fixture = await sandboxGithubFixture(policy)
    const shared = await sharedOpenCodeFixture(`terminal-${reason}`)
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
            executor: shared.executor,
            client: shared.client,
            executorId: "opencode:opencode-primary",
            endpointIdentity: shared.url,
          })
          yield* runs.create(sandboxRun(directory, "fixture", "Task"))
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
      await shared.close()
      await fixture.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

test("sandbox routes retain ordinary authentication preflight before leasing", async () => {
  const state = defaultState()
  state.providers = []
  let launched = false
  const sandbox: SandboxDispatchPort = {
    launch: () => {
      launched = true
      return Effect.succeed({ nativeSessionId: "ses_child", endpoint: "http://127.0.0.1:12345" })
    },
    owns: () => Effect.succeed(true),
    cancel: () => Effect.void,
    observe: () => Effect.void,
    iteration: Effect.void,
    heartbeat: Effect.void,
    provider: () => Effect.die("unused"),
  }
  const layer = makeLayer(makeProvider(state), worktrees([]), undefined, {
    sandboxRepositories: [policy],
  }).pipe(Layer.provideMerge(Layer.succeed(SandboxDispatch, sandbox)))
  const result = await Effect.runPromise(
    register(submission).pipe(Effect.provide(layer), Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(launched).toBe(false)
})

test("session reservation needs no private unit and rejects cross-lease reuse", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeSandboxStore
      for (const runId of ["first", "second"]) {
        yield* store.request({
          runId,
          leaseId: runId,
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
      }
      yield* store.attachSession("first", "ses_reserved")
      yield* store.attachSession("first", "ses_reserved")
      expect((yield* store.bySession("ses_reserved"))?.run_id).toBe("first")
      expect((yield* Effect.result(store.attachSession("second", "ses_reserved")))._tag).toBe(
        "Failure",
      )
      expect((yield* Effect.result(store.attachSession("first", "ses_other")))._tag).toBe("Failure")
    }).pipe(
      Effect.provide(
        WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  )
})

test.each([
  ["openai", "gpt-6-astra-fixture", "fixture-model-canary", 0],
  ["fixture-second", "second-model", "second-fixture-canary", 0],
  ["openai", "gpt-6-astra-fixture", "fixture-model-canary", 401],
  ["openai", "gpt-6-astra-fixture", "fixture-model-canary", 403],
])(
  "real ingress preserves %s/%s (%s, HTTP %s)",
  async (providerID, modelID, canary, rejection) => {
    const runner = await dispatchRunnerFixture()
    const shared = await sharedOpenCodeFixture(`ingress-${providerID}`)
    const fixture = await sandboxGithubFixture(policy, runner.name)
    const controlDirectory = join(shared.root, "ordinary")
    const control = await shared.create(controlDirectory, "build")
    try {
      const sandbox = Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github, runner.root)
        const store = yield* makeSandboxStore
        const service = yield* makeSandboxDispatch({
          policies: [policy],
          github,
          leases,
          client: shared.client,
          executor: shared.executor,
          executorId: "opencode:opencode-primary",
          endpointIdentity: shared.url,
        })
        return {
          ...service,
          launch: (run, model) =>
            Effect.gen(function* () {
              // The GitHub/Tailscale acquisition boundary has separate real-SSH coverage.
              yield* store.request({
                runId: run.runId,
                leaseId: runner.name,
                policy,
                sourceSha: "b".repeat(40),
                now: Date.now(),
              })
              yield* store.beginStart(run.runId)
              yield* store.recordRun(run.runId, 41, 1)
              yield* store.bind(run.runId, 41, 1, runner.transport)
              expect(model).toEqual({ providerID, modelID })
              return yield* service.launch(run, model)
            }).pipe(Effect.mapError(() => new SandboxError({ message: "Fixture launch failed" }))),
        } satisfies SandboxDispatchPort
      }).pipe(Effect.orDie)
      const layer = await sandboxIngressFixtureLayer(shared.executor, sandbox, policy, {
        root: join(shared.root, "dispatch"),
        providerID,
        modelID,
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          shared.script([], "selected model response")
          if (rejection) {
            shared.reject({ path: "/agent", method: "POST", status: rejection })
            expect(
              (yield* Effect.result(register({ ...submission, prompt: "Reject this prompt" })))
                ._tag,
            ).toBe("Failure")
            shared.reject()
            const leases = yield* makeSandboxStore
            const [lease] = yield* leases.active()
            expect(lease?.session_id).not.toBeNull()
            expect(lease?.state).toBe("releasing")
            const runs = yield* AgentRunStore
            const run = yield* runs.read(lease?.run_id ?? "")
            expect(
              (yield* Effect.tryPromise(() => readSandboxBinding(run?.directory ?? ""))).state,
            ).toBe("revoked")
            fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
            const service = yield* SandboxDispatch
            yield* service.iteration
            expect((yield* leases.read(lease?.run_id ?? ""))?.state).toBe("released")
            return
          }
          const receipt = yield* register({
            ...submission,
            prompt: "Respond with the fixture result",
          })
          const runs = yield* AgentRunStore
          const run = yield* runs.read(receipt.runId)
          expect(run).toMatchObject({ agent: "sandbox", providerId: providerID, modelId: modelID })
          expect(shared.credentials).toContain(`Bearer ${canary}`)
          const dispatch = yield* SandboxDispatch
          const provider = yield* dispatch.provider(receipt.nativeSessionId)
          const directory = run?.directory ?? ""
          for (const text of ["Continue this sandbox task", "Retry this sandbox task"]) {
            yield* provider.promptSession({
              sessionID: receipt.nativeSessionId,
              directory,
              agent: "sandbox",
              model: { providerID, modelID },
              text,
            })
            yield* Effect.tryPromise(() =>
              shared.api(`session/${receipt.nativeSessionId}/wait`, {}),
            )
          }
          const session = yield* shared.client.session.get({
            sessionID: Session.ID.make(receipt.nativeSessionId),
          })
          expect(String(session.agent)).toBe("sandbox")
          expect(session.model).toMatchObject({ providerID, id: modelID })
          const foreignDirectory = join(shared.root, "foreign")
          const foreign = yield* Effect.tryPromise(() => shared.create(foreignDirectory, "sandbox"))
          const bridge = (yield* Effect.tryPromise(() => readSandboxBinding(directory)))
            .bridgeServerName
          shared.script([
            {
              name: "execute",
              arguments: JSON.stringify({
                code: `return await tools.${bridge}.environment_list({environment_source:"/workspace/repository"})`,
              }),
            },
          ])
          const foreignTurn = yield* Effect.tryPromise(() =>
            shared.prompt(foreign, "Try a foreign lease"),
          )
          expect(JSON.stringify(foreignTurn)).toContain("Unknown tool")
          const sql = yield* SqlClient.SqlClient
          const identity =
            yield* sql`SELECT endpoint_identity,endpoint_alias,server_id FROM kernel_sessions WHERE session_id=${receipt.sessionId}`
          expect(identity[0]).toMatchObject({
            endpoint_alias: "local",
            server_id: "opencode-primary",
          })
          shared.script([
            {
              name: "shell",
              arguments: JSON.stringify({
                command: "printf ordinary > control",
                description: "Ordinary control",
              }),
            },
          ])
          yield* Effect.tryPromise(() => shared.prompt(control, "Ordinary tools remain usable"))
          expect(
            yield* Effect.tryPromise(() => Bun.file(join(controlDirectory, "control")).text()),
          ).toBe("ordinary")
          const ingress = yield* AgentRunIngress
          yield* ingress.cancel(receipt.runId, new Date())
          fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
          yield* dispatch.iteration
          expect((yield* runs.read(receipt.runId))?.state).toBe("cancelled")
          expect(
            String(
              (yield* shared.client.session.get({ sessionID: Session.ID.make(control) })).agent,
            ),
          ).toBe("build")
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      await fixture.close()
      await shared.close()
      await runner.close()
    }
  },
  120000,
)
