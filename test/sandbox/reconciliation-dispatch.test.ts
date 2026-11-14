import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { OpenCode } from "@opencode-ai/client/effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../src/opencode/adapter"
import { makeSandboxDispatch } from "../../src/sandbox/dispatch"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore } from "../../src/sandbox/store"
import { runStoreMigrations } from "../../src/store/migrations"
import { sandboxGithubFixture } from "./harness"

test("native release and reconciliation share repository inventory admission across wakeups", async () => {
  const policy = {
    alias: "fixture",
    repository: "fixture/repo",
    repositoryId: 12,
    installationId: 1,
    workflowSha: "a".repeat(40),
    appActorId: 56,
    agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
    tailscaleClientId: "fixture",
    tailscaleAudience: "fixture",
    privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 },
  }
  const root = await mkdtemp(join(tmpdir(), "inventory-dispatch-"))
  const fixture = await sandboxGithubFixture(policy)
  let inventories = 0
  let partition = true
  fixture.listRuns([])
  fixture.publication(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/actions/runs") && !url.searchParams.has("branch")) {
      inventories++
      if (partition) return new Response(null, { status: 503 })
    }
    return undefined
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const runs = yield* AgentRunStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        const client = yield* OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).pipe(
          Effect.provide(FetchHttpClient.layer),
        )
        const dispatch = yield* makeSandboxDispatch({
          policies: [policy],
          github,
          leases,
          client,
          executor: new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client))),
          executorId: "opencode:unused",
          endpointIdentity: "http://127.0.0.1:1",
        })
        for (const id of [41, 42]) {
          const runId = `releasing-${id}`
          const directory = join(root, runId)
          yield* Effect.promise(async () => {
            await mkdir(directory)
            await writeFile(
              join(directory, "terminal.json"),
              JSON.stringify({
                state: "cancelled",
                sessionId: null,
                finalMessage: null,
                diagnostic: "fixture",
              }),
            )
          })
          yield* runs.create({
            runId,
            directory,
            route: "native",
            providerId: "anthropic",
            modelId: "fixture",
            executorKind: "claude",
            agent: "sandbox",
            repository: policy.alias,
            prompt: "fixture",
            promptSha256: "a".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          yield* store.request({
            runId,
            leaseId: runId,
            policy,
            sourceSha: "d".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart(runId)
          yield* store.recordRun(runId, id, 1)
          yield* store.beginRelease(runId)
          fixture.savedRun(id, { head_branch: `workflowd/leases/${runId}` })
        }
        yield* Effect.promise(() => Bun.sleep(2)).pipe(
          Effect.andThen(TestClock.adjust("100 millis")),
          Effect.forever,
          Effect.forkChild,
        )
        for (let wake = 0; wake < 3; wake++) yield* dispatch.iteration.pipe(Effect.result)
        expect(inventories).toBe(1)
        expect(new Set(fixture.cancellations)).toEqual(new Set([41, 42]))
        expect(fixture.cancellations.length).toBeGreaterThan(4)
        expect(yield* store.active()).toHaveLength(2)
        expect(fixture.refDeletes).toBe(0)
        partition = false
        yield* TestClock.adjust("60 seconds")
        yield* dispatch.iteration
        expect(inventories).toBe(6)
        for (const id of [41, 42])
          fixture.savedRun(id, {
            head_branch: `workflowd/leases/releasing-${id}`,
            status: "completed",
            conclusion: "cancelled",
          })
        yield* dispatch.iteration
        expect(inventories).toBe(6)
        expect(yield* store.active()).toHaveLength(0)
        expect(fixture.refDeletes).toBe(2)
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    )
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
