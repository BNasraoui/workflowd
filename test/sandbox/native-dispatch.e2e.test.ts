import { expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { dispatchRunnerFixture, sandboxGithubFixture, sandboxIngressFixtureLayer } from "./harness"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import { nativeModelFixture, remoteEnvironment } from "./native-fixture"
import { makeCodexCli } from "../../src/kernel/codex-session"
import { makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeSandboxDispatch, SandboxDispatch } from "../../src/sandbox/dispatch"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore, SandboxError } from "../../src/sandbox/store"
import { readSandboxBinding } from "../../src/sandbox/binding"

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

for (const [kind, mode] of [
  ["codex", "completed"],
  ["claude", "completed"],
  ["codex", "cancelled"],
  ["codex", "restart"],
] as const) {
  test(`native ${kind} ${mode} uses leased custody and publishes only after release`, async () => {
    const runner = await dispatchRunnerFixture()
    const shared = await sharedOpenCodeFixture(`native-${kind}`)
    const fixture = await nativeModelFixture(kind, runner.root)
    const githubFixture = await sandboxGithubFixture(policy, runner.name)
    const cli = {
      ...(kind === "codex" ? makeCodexCli : makeClaudeDispatchCli)({
        binary: fixture.binary,
        custodyRoot: join(runner.root, "processes"),
        unitPrefix: `wfd-native-test-${crypto.randomUUID()}-`,
      }),
      preflight: Effect.void,
    }
    const sandbox = Effect.gen(function* () {
      const github = yield* makeSandboxGithub(githubFixture.github, githubFixture.OctokitClass)
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
        nativeExecutors: { [kind]: cli },
      })
      return {
        ...service,
        prepareNative: (run: import("../../src/kernel/agent-run-store").AgentRunRecord) =>
          Effect.gen(function* () {
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
            return yield* service.prepareNative(run)
          }).pipe(
            Effect.mapError(
              () => new SandboxError({ message: "Native fixture preparation failed" }),
            ),
          ),
      }
    }).pipe(Effect.orDie)
    const layer = await sandboxIngressFixtureLayer(shared.executor, sandbox, policy, {
      root: join(runner.root, "dispatch"),
      providerID: "unused",
      modelID: "dispatch-selected-fixture",
      native: {
        kind,
        cli:
          kind === "codex" && mode === "completed"
            ? {
                ownership: "resident-thread",
                preflight: Effect.void,
                spawn: () =>
                  Effect.die("Sandbox must use transient custody, not the resident executor"),
                cancelRun: () => Effect.die("Sandbox must cancel its transient executor"),
              }
            : cli,
      },
      database: join(runner.root, "runs.sqlite"),
    })
    const runtime = ManagedRuntime.make(layer)
    try {
      fixture.actions.push(
        {
          name: "environment_create",
          arguments: {
            environment_source: "/workspace/repository",
            title: "Native remote fixture",
          },
        },
        (request) => ({
          name: "environment_run_cmd",
          arguments: {
            environment_source: "/workspace/repository",
            environment_id: remoteEnvironment(request),
            command:
              "printf remote-native > native-proof.txt; test $(cat native-proof.txt) = remote-native && printf native-tests-passed",
          },
        }),
      )
      if (mode !== "completed") {
        fixture.actions.splice(0, fixture.actions.length, {
          name: "environment_list",
          arguments: { environment_source: "/workspace/repository" },
        })
        fixture.holdAfter(1)
      }
      const ingress = await runtime.runPromise(AgentRunIngress)
      const receipt = await runtime.runPromise(
        ingress.register(
          {
            route: "native",
            repository: policy.alias,
            prompt: "List remote environments and finish",
            idempotencyKey: runner.name,
          },
          new Date(),
        ),
      )
      const runs = await runtime.runPromise(AgentRunStore)
      const leases = await runtime.runPromise(makeSandboxStore)
      const service = await runtime.runPromise(SandboxDispatch)
      const run = await runtime.runPromise(runs.read(receipt.runId))
      expect(run).not.toBeNull()
      expect((await readdir(run!.directory)).includes(".git")).toBe(false)
      const binding = await readSandboxBinding(run!.directory)
      expect(binding.sessionId).not.toBe(receipt.nativeSessionId)
      expect(binding.executorId).toBe(`${kind}:local`)
      if (mode === "cancelled") await runtime.runPromise(ingress.cancel(run!.runId, new Date()))
      if (mode === "restart") await runtime.runPromise(sandbox)
      const deadline = Date.now() + 60000
      while ((await runtime.runPromise(leases.read(run!.runId)))?.state !== "releasing") {
        if (Date.now() >= deadline) throw new Error("Native fixture did not settle")
        await Bun.sleep(50)
      }
      expect((await runtime.runPromise(runs.read(run!.runId)))?.state).toBe("verified")
      githubFixture.mutateRun({ status: "completed", conclusion: "cancelled" })
      await runtime.runPromise(service.iteration)
      expect((await runtime.runPromise(runs.read(run!.runId)))?.state).toBe(
        mode === "restart" ? "operator_required" : mode,
      )
      expect((await runtime.runPromise(leases.read(run!.runId)))?.state).toBe("released")
      expect((await readSandboxBinding(run!.directory)).state).toBe("revoked")
      if (mode === "completed") {
        expect(fixture.requests.length).toBeGreaterThan(2)
        expect(JSON.stringify(fixture.requests.at(-1))).toContain("native-tests-passed")
        expect(await Bun.file(join(run!.directory, "native-proof.txt")).exists()).toBe(false)
        expect(await Bun.file(join(run!.directory, "result.patch")).text()).toContain(
          "remote-native",
        )
      }
    } finally {
      await runtime.dispose()
      await fixture.close()
      await githubFixture.close()
      await shared.close()
      await runner.close()
    }
  }, 300000)
}
