/* global Bun */
import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { WorkflowStoreLive } from "../../src/store.ts"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store.ts"
import { makeSandboxStore } from "../../src/sandbox/store.ts"
import { makeSandboxGithub } from "../../src/sandbox/github.ts"
import { makeSandboxLeaseService } from "../../src/sandbox/lease.ts"
import { makeSandboxDispatch } from "../../src/sandbox/dispatch.ts"
import { drainToolAudit, sendToolAudit } from "../../src/sandbox/audit.ts"
import { command, dispatchRunnerFixture, sandboxGithubFixture } from "../../test/sandbox/harness.ts"
import { sharedOpenCodeFixture } from "../../test/sandbox/opencode-fixture.ts"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "f".repeat(64),
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
}
let runner
let githubFixture
let shared
try {
  const libraries = await command([
    "python3",
    "-c",
    `
import hashlib,json,pathlib
routes={name:pathlib.Path('/proc/net/'+name).read_text() for name in ['route','ipv6_route']}
pathlib.Path('/evidence/legacy-audit-routes.json').write_text(json.dumps(routes))
assert not any(row.split()[1]=='00000000' for row in routes['route'].splitlines()[1:])
assert not any(row.split()[0]=='0'*32 and row.split()[1]=='00' and row.split()[-1]!='lo' for row in routes['ipv6_route'].splitlines())
names=['libc.so.6','ld-linux-x86-64.so.2','libpthread.so.0','libdl.so.2','libm.so.6','librt.so.1','libutil.so.1','libstdc++.so.6','libgcc_s.so.1']
libraries=[]
for name in names:
 path=(pathlib.Path('/usr/lib/x86_64-linux-gnu')/name).resolve(strict=True)
 libraries.append({'name':name,'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
print(json.dumps({'libraries':libraries,'defaultRoutesAbsent':True}))
`,
  ])
  await Bun.write("/evidence/legacy-audit-libraries.json", libraries)
  const started = await Promise.allSettled([
    dispatchRunnerFixture().then((value) => {
      runner = value
    }),
    sharedOpenCodeFixture("audit-admission").then((value) => {
      shared = value
    }),
  ])
  for (const result of started) {
    if (result.status === "rejected") throw result.reason
  }
  githubFixture = await sandboxGithubFixture(policy, runner.name)
  const directory = join(runner.root, "control")
  await Effect.runPromise(
    Effect.gen(function* () {
      const runs = yield* AgentRunStore
      const store = yield* makeSandboxStore
      const github = yield* makeSandboxGithub(githubFixture.github, githubFixture.OctokitClass)
      const leases = yield* makeSandboxLeaseService(github, directory)
      const service = yield* makeSandboxDispatch({
        policies: [policy],
        github,
        leases,
        executor: shared.executor,
        client: shared.client,
        executorId: "opencode:opencode-primary",
        endpointIdentity: shared.url,
      })
      yield* runs.create({
        runId: "run-1",
        route: "sandbox",
        providerId: "openai",
        modelId: "gpt-6-astra-fixture",
        agent: "sandbox",
        repository: policy.alias,
        directory,
        prompt: "Audit admission",
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
      const run = yield* runs.read("run-1")
      assert.ok(run)
      const launched = yield* service.launch(run, {
        providerID: "openai",
        modelID: "gpt-6-astra-fixture",
      })
      yield* Effect.tryPromise(async () => {
        const binding = await Bun.file(`${directory}.sandbox/binding.json`).json()
        shared.script([
          {
            name: "execute",
            arguments: JSON.stringify({
              code: `return await tools[${JSON.stringify(binding.bridgeServerName)}].environment_list({ environment_source: "/workspace/repository" })`,
            }),
          },
        ])
        const response = await shared.prompt(
          launched.nativeSessionId,
          "List the disposable environments",
        )
        assert.ok(shared.requests.length >= 2)
        assert.ok(shared.credentials.every((value) => value === "Bearer fixture-model-canary"))
        await drainToolAudit(directory, (records) => sendToolAudit(runner.transport, records))
        const receipt = await Bun.file(`${directory}.sandbox/audit-receipt.json`).json()
        assert.equal(receipt.emittedThrough, 1)
        const remote = JSON.parse(
          await runner.docker(
            "exec",
            `${runner.name}-runner`,
            "cat",
            "/run/workflowd-sandbox/audit.json",
          ),
        )
        assert.equal(remote.emittedThrough, 1)
        await Bun.write(
          "/evidence/legacy-audit-startup.json",
          JSON.stringify({
            launched,
            binding,
            requests: shared.requests,
            credentials: shared.credentials,
            response,
            receipt,
            remote,
          }),
        )
        if (process.env.WORKFLOWD_FIXTURE_LEGACY_DEATH === "1") {
          const uid = process.env.WORKFLOWD_FIXTURE_EVIDENCE_UID
          const gid = process.env.WORKFLOWD_FIXTURE_EVIDENCE_GID
          assert.match(uid ?? "", /^\d+$/)
          assert.match(gid ?? "", /^\d+$/)
          await command(["chown", "-R", `${uid}:${gid}`, "/evidence"])
          await Bun.write("/evidence/legacy-runner-ready", "ready\n")
          await Bun.sleep(120000)
        }
      })
      yield* service.cancel(run)
    }).pipe(
      Effect.provide(
        AgentRunStoreLive.pipe(
          Layer.provideMerge(
            WorkflowStoreLive.pipe(
              Layer.provideMerge(
                SqliteClient.layer({ filename: join(runner.root, "admission.sqlite") }),
              ),
            ),
          ),
        ),
      ),
    ),
  )
} finally {
  try {
    await shared?.close()
  } finally {
    try {
      await githubFixture?.close()
    } finally {
      await runner?.close()
    }
  }
}
