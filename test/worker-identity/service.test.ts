import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { WorkerIdentity, WorkerIdentityLive } from "../../src/worker-identity/service"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { WorkflowStoreLive } from "../../src/store"
import { githubFixture } from "../ci/github-fixture"
test("brokers by process ancestry and never writes shared capabilities", async () => {
  const fixture = await githubFixture()
  const config = {
    directory: join(fixture.directory, "identities"),
    socket: join(fixture.directory, "broker.sock"),
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
        for (const runId of ["run", "other"]) {
          yield* runs.create({
            runId,
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
          yield* runs.claimSpawn({ runId, now })
        }
        const run = yield* runs.read("run")
        expect(run).not.toBeNull()
        const instruction = yield* service.provision(run!)
        expect(instruction).not.toContain("--identity")
        expect(yield* Effect.promise(() => readdir(config.directory))).toEqual([])
        const children = ["run", "other"].map(() =>
          Bun.spawn(
            [
              process.execPath,
              "-e",
              `
          const { requestRunSocket } = await import(process.env.TEST_CLIENT);
          await Bun.stdin.text();
          const statuses = [];
          for (const run of ["run", "other"]) statuses.push((await requestRunSocket(process.env.TEST_SOCKET, "/workers/github/" + run + "/token")).status);
          console.log(statuses.join(","));
        `,
            ],
            {
              env: {
                ...process.env,
                TEST_SOCKET: config.socket,
                TEST_CLIENT: join(import.meta.dir, "../../src/worker-identity/socket-client.ts"),
              },
              stdin: "pipe",
              stdout: "pipe",
            },
          ),
        )
        yield* Effect.try(() => {
          children.forEach((child, i) => service.register(i === 0 ? "run" : "other", child.pid))
        })
        for (const child of children) void child.stdin.end()
        expect((yield* Effect.promise(() => new Response(children[0]!.stdout).text())).trim()).toBe(
          "200,403",
        )
        expect((yield* Effect.promise(() => new Response(children[1]!.stdout).text())).trim()).toBe(
          "403,200",
        )
        yield* Effect.promise(() => Promise.all(children.map((child) => child.exited)))

        expect(
          (yield* Effect.promise(() =>
            requestRunSocket(config.socket, "/workers/github/run/token"),
          )).status,
        ).toBe(403)
        expect(fixture.bodies).toEqual([{ repositories: ["r"], permissions: { actions: "read" } }])
        yield* runs.fail({ runId: "run", diagnostic: "done", now })
      }).pipe(Effect.provide(live)),
    )
  } finally {
    await fixture.close()
  }
})
