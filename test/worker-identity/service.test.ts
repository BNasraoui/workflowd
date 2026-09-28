import { expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { WorkerIdentity, WorkerIdentityLive } from "../../src/worker-identity/service"
import { workerCapability } from "../../src/worker-identity/access"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { WorkflowStoreLive } from "../../src/store"
import { githubFixture } from "../ci/github-fixture"
test("provisions private run capabilities and brokers tokens only while the run is live", async () => {
  const fixture = await githubFixture()
  const config = {
    secret: "x".repeat(32),
    directory: join(fixture.directory, "identities"),
    endpoint: "http://127.0.0.1:8787",
    policies: [
      {
        name: "repo",
        repository: "o/r",
        installationId: 1,
        permissions: { actions: "read" as const },
      },
    ],
  }
  const live = WorkerIdentityLive(config, fixture.github, fixture.OctokitClass).pipe(
    Layer.provideMerge(AgentRunStoreLive),
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkerIdentity
        const runs = yield* AgentRunStore
        const now = new Date()
        yield* runs.create({
          runId: "run",
          route: "r",
          providerId: "codex-cli",
          modelId: "model",
          agent: "build",
          repository: "repo",
          directory: fixture.directory,
          prompt: "task",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 3,
          createdAt: now,
        })
        yield* runs.claimSpawn({ runId: "run", now })
        const run = yield* runs.read("run")
        expect(run).not.toBeNull()
        const instruction = yield* service.provision(run!)
        const path = join(
          config.directory,
          `${createHash("sha256").update("run").digest("hex")}.json`,
        )
        expect(instruction).toContain(path)
        expect(instruction).not.toContain(workerCapability(config.secret, "run"))
        expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600)
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toContain(
          workerCapability(config.secret, "run"),
        )
        const request = (cap: string) =>
          new Request("http://localhost/workers/github/run/token", {
            method: "POST",
            headers: { authorization: `Bearer ${cap}` },
          })
        expect((yield* service.route(request("wrong")))?.status).toBe(403)
        const response = yield* service.route(request(workerCapability(config.secret, "run")))
        expect(response?.headers.get("cache-control")).toBe("no-store")
        expect(yield* Effect.promise(() => response!.json())).toMatchObject({
          token: "test-installation-token",
        })
        expect(fixture.bodies).toEqual([{ repositories: ["r"], permissions: { actions: "read" } }])
        yield* runs.fail({ runId: "run", diagnostic: "done", now })
        expect(
          (yield* service.route(request(workerCapability(config.secret, "run"))))?.status,
        ).toBe(403)
      }).pipe(Effect.provide(live)),
    )
  } finally {
    await fixture.close()
  }
})
