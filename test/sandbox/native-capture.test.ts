import { expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeCapabilityStore, capabilityDigest } from "../../src/capability-gateway/store"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { sandboxGithubFixture } from "./harness"
import { makeSandboxDispatch } from "../../src/sandbox/dispatch"
import { makeSandboxStore } from "../../src/sandbox/store"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { runStoreMigrations } from "../../src/store/migrations"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../src/opencode/adapter"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("native capture requires frozen current result and checks exact source/metadata receipts", async () => {
  const evidence = await mkdtemp(join(tmpdir(), "native-evidence-"))
  const policy = {
    alias: "fixture",
    repository: "fixture/repo",
    repositoryId: 12,
    installationId: 1,
    workflowSha: "a".repeat(40),
    appActorId: 56,
    agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
    tailscaleClientId: "fixture",
    tailscaleAudience: "fixture",
  }
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases } = yield* seedCapabilityRun(Date.now(), true)
        const capabilities = yield* makeCapabilityStore
        const job = yield* capabilities.challenge("run", transport, Date.now())
        const binding = yield* capabilities.bind(
          job,
          "jti",
          capabilityDigest("fixture"),
          Date.now() + 60000,
          Date.now(),
        )
        yield* leases.bind("run", 78, 1, transport)
        const native = yield* makeNativeExecutionStore
        const invocation = yield* native.reserve("run")
        yield* native.acknowledge("run", invocation.nonce)
        const results = yield* makeNativeResultStore
        const completion = {
          branch: "arbitrary/branch",
          title: "Native result",
          body: "Useful result",
          commitMessage: "Result",
        }
        yield* results.submit(binding, { revision: 0, completion })
        const lease = (yield* leases.read("run"))!
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const calls: string[] = []
        let swapped = false
        const service = yield* makeSandboxLeaseService(github, "/fixture", async (args, input) => {
          calls.push(args.at(-1)!)
          if (args.at(-1)!.endsWith("native-evidence"))
            return JSON.stringify({
              nonce: invocation.nonce,
              session: invocation.session_id,
              pty: Buffer.from("::error::private fixture trace").toString("base64"),
            })
          if (args.at(-1)!.endsWith("native-result")) {
            expect(JSON.parse(input)).toEqual({
              nonce: invocation.nonce,
              session: invocation.session_id,
              completion,
            })
            return JSON.stringify({
              ...completion,
              title: swapped ? "Foreign" : completion.title,
              sourceSha: lease.source_sha,
              resultSha: "e".repeat(40),
              treeSha: "f".repeat(40),
              bundleSha256: "b".repeat(64),
              manifestSha256: "c".repeat(64),
            })
          }
          return lease.source_sha
        })
        expect((yield* service.finishResult("run", "ignored prose").pipe(Effect.result))._tag).toBe(
          "Failure",
        )
        expect(calls).toHaveLength(0)
        yield* native.closed("run", invocation.nonce, "completed", 1)
        expect(yield* service.finishResult("run", "ignored prose")).toMatchObject(completion)
        expect(calls).toEqual(["exec /usr/local/bin/runner-control native-result"])
        yield* service.audit("run", join(evidence, "run"))
        expect(
          yield* Effect.promise(() =>
            Bun.file(join(evidence, "run.sandbox/native-evidence.json")).json(),
          ),
        ).toEqual({
          nonce: invocation.nonce,
          session: invocation.session_id,
          pty: Buffer.from("::error::private fixture trace").toString("base64"),
        })
        swapped = true
        expect((yield* service.finishResult("run", "ignored prose").pipe(Effect.result))._tag).toBe(
          "Failure",
        )
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await fixture.close()
    await rm(evidence, { recursive: true, force: true })
  }
})

test("native preparation reserves the job's session and source without invoking a local worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-prepare-"))
  const policy = {
    alias: "fixture",
    repository: "fixture/repo",
    repositoryId: 12,
    installationId: 1,
    workflowSha: "a".repeat(40),
    appActorId: 56,
    agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
    tailscaleClientId: "fixture",
    tailscaleAudience: "fixture",
    privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 },
  }
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO directory_local_identity(singleton,host_id) VALUES(1,'fixture-controller')`
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxStore
        const remote = yield* makeSandboxLeaseService(github, root)
        const client = yield* OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).pipe(
          Effect.provide(FetchHttpClient.layer),
        )
        let initialized = 0
        const service = yield* makeSandboxDispatch({
          nativeScope: yield* Scope.Scope,
          publicationContract: { reference: "fixture-only:worktree", receipt: "fixed-v1" },
          policies: [policy],
          github: {
            ...github,
            verifyWorkflow: () => Effect.succeed(undefined),
            resolveSource: () => Effect.succeed("a".repeat(40)),
          },
          leases: {
            ...remote,
            initializeNative: () =>
              Effect.sync(() => {
                initialized++
                return undefined
              }),
            acquire: (runId) =>
              Effect.gen(function* () {
                yield* leases.beginStart(runId)
                yield* leases.recordRun(runId, 78, 1)
                const capabilities = yield* makeCapabilityStore
                const job = yield* capabilities.challenge(
                  runId,
                  { ...transport, leaseId: runId },
                  Date.now(),
                )
                yield* capabilities.bind(
                  job,
                  "jti",
                  capabilityDigest("fixture"),
                  Date.now() + 60000,
                  Date.now(),
                )
                yield* leases.bind(runId, 78, 1, { ...transport, leaseId: runId })
                return (yield* leases.read(runId))!
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          },
          client,
          executor: new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client))),
          executorId: "opencode:unused",
          endpointIdentity: "http://127.0.0.1:1",
        })
        const runs = yield* AgentRunStore
        yield* runs.create({
          runId: "native-prepare",
          route: "native",
          providerId: "anthropic",
          modelId: "fixture-model",
          executorKind: "claude",
          agent: "sandbox",
          repository: "fixture",
          directory: join(root, "run"),
          prompt: "Fixture",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 1,
          createdAt: new Date(),
          resolvedSelection: {
            executor: "claude:actions",
            executorKind: "claude",
            host: "github-actions",
            provider: "anthropic",
            model: "fixture-model",
            selectionModel: "fixture-model",
            thinking: {},
            availability: "unknown",
            evidence: "configured",
          },
        })
        yield* runs.claimSpawn({ runId: "native-prepare", now: new Date() })
        const attachment = yield* service.prepareNative((yield* runs.read("native-prepare"))!)
        const invocation = yield* (yield* makeNativeExecutionStore).read("native-prepare")
        expect(attachment.cli.ownership).toBe("transient-exec")
        expect(initialized).toBe(1)
        expect((yield* leases.read("native-prepare"))?.session_id).toBe(invocation?.session_id)
        expect((yield* runs.read("native-prepare"))?.resolvedSelection).toMatchObject({
          host: "github-actions:78:1",
          executor: "claude:actions",
          thinking: { effort: "high" },
        })
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})
