import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
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
  const environments = new Map<string, Readonly<Record<string, string>>>()
  const live = WorkerIdentityLive(config, fixture.github, fixture.OctokitClass, {
    serverId: "fixture",
    owningHostId: "fixture",
    providerId: "fixture",
    providerVersion: 1,
    endpointAlias: "fixture",
    endpointIdentity: "http://fixture",
    setSessionEnvironment: (input) =>
      Effect.sync(() => {
        environments.set(input.sessionID, input.variables)
      }),
  }).pipe(
    Layer.provideMerge(AgentRunStoreLive),
    Layer.provideMerge(KernelSessionStoreLive),
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(SqliteClient.layer({ filename: join(fixture.directory, "identity.db") })),
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkerIdentity
        const runs = yield* AgentRunStore
        const now = new Date()
        for (const runId of ["run", "other", "session"]) {
          yield* runs.create({
            runId,
            route: "r",
            providerId: runId === "session" ? "opencode" : "claude-cli",
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
        const nativeSessionId = "opencode-session"
        const custody = yield* KernelSessionStore
        yield* custody.registerResource({
          resourceId: "resource",
          owningHostId: "fixture",
          absolutePath: fixture.directory,
          kind: "worktree",
          createdAt: now,
        })
        yield* custody.registerSession({
          sessionId: "session-record",
          nativeSessionId,
          resourceId: "resource",
          owningHostId: "fixture",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "fixture",
          serverId: "fixture",
          endpointAlias: "fixture",
          endpointIdentity: "http://fixture",
          createdAt: now,
        })
        yield* runs.markSpawned({
          runId: "session",
          resourceId: "resource",
          sessionId: "session-record",
          nativeSessionId,
          now,
        })
        yield* service.provision((yield* runs.read("session"))!)
        const capability = environments.get(nativeSessionId)!.WORKFLOWD_WORKER_CAPABILITY!
        expect(environments.get(nativeSessionId)?.WORKFLOWD_WORKER_SESSION_ID).toBe(nativeSessionId)
        const request = (runId: string, value = capability, sessionId = nativeSessionId) =>
          Effect.promise(() =>
            requestRunSocket(
              config.socket,
              `/workers/github/${runId}/token`,
              JSON.stringify({ capability: value, sessionId }),
            ),
          )
        expect((yield* request("session")).status).toBe(200)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_sessions SET endpoint_identity='http://foreign' WHERE session_id='session-record'`
        expect((yield* request("session")).status).toBe(403)
        yield* sql`UPDATE kernel_sessions SET endpoint_identity='http://fixture' WHERE session_id='session-record'`

        expect((yield* request("run")).status).toBe(403)
        expect((yield* request("session", "0".repeat(64))).status).toBe(403)
        expect((yield* request("session", capability, "foreign-session")).status).toBe(403)
        const rotated = service.bindSession("session", nativeSessionId)
        expect((yield* request("session")).status).toBe(403)
        expect((yield* request("session", rotated)).status).toBe(200)
        service.revoke("session")
        expect((yield* request("session", rotated)).status).toBe(403)
        yield* custody.registerSession({
          sessionId: "claude-record",
          nativeSessionId: "claude-session",
          resourceId: "resource",
          owningHostId: "fixture",
          providerKind: "claude",
          providerVersion: 1,
          providerId: "claude-cli",
          serverId: "fixture",
          endpointAlias: "fixture",
          endpointIdentity: "claude-cli://fixture",
          createdAt: now,
        })
        yield* runs.markSpawned({
          runId: "run",
          resourceId: "resource",
          sessionId: "claude-record",
          nativeSessionId: "claude-session",
          now,
        })
        expect(yield* service.nativeRun("claude-session", fixture.directory)).toBe("run")
        expect(yield* service.nativeRun("claude-session", "/foreign")).toBeNull()
        yield* runs.fail({ runId: "run", diagnostic: "done", now })
        expect(yield* service.nativeRun("claude-session", fixture.directory)).toBeNull()
      }).pipe(Effect.provide(live)),
    )
    const previous = environments.get("opencode-session")!.WORKFLOWD_WORKER_CAPABILITY
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkerIdentity
        const runs = yield* AgentRunStore
        const env = environments.get("opencode-session")!
        expect(env.WORKFLOWD_WORKER_CAPABILITY).not.toBe(previous)
        const request = (capability: string | undefined) =>
          Effect.promise(() =>
            requestRunSocket(
              config.socket,
              "/workers/github/session/token",
              JSON.stringify({ sessionId: "opencode-session", capability }),
            ),
          )
        expect((yield* request(previous)).status).toBe(403)
        expect((yield* request(env.WORKFLOWD_WORKER_CAPABILITY)).status).toBe(200)
        yield* runs.fail({ runId: "session", diagnostic: "finished", now: new Date() })
        expect((yield* request(env.WORKFLOWD_WORKER_CAPABILITY)).status).toBe(403)
      }).pipe(Effect.provide(live)),
    )
  } finally {
    await fixture.close()
  }
})
