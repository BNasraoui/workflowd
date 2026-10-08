import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Fiber, Layer } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DirectoryStore, DirectoryStoreLive } from "../../src/directory/store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { WorkflowStoreLive } from "../../src/store"
import { ResidentCodex, ResidentCodexLive } from "../../src/resident/service"
import { startAppServer } from "../../src/resident/process"
import { makeResidentStore } from "../../src/resident/store"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"

test("resident restart exposes no old endpoint while attaching and restores it only after native resume/read", async () => {
  const root = await mkdtemp(join(tmpdir(), "directory-resident-"))
  const binary = join(root, "native-fixture")
  await writeFile(
    binary,
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(import.meta.dir, "fixtures/resident-directory.mjs"))})`,
    { mode: 0o700 },
  )
  const attaching = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const owner = Promise.withResolvers<void>()
  const native: typeof startAppServer = (options, notify) => {
    const process = startAppServer(options, notify)
    return {
      ...process,
      initialize: async () => {
        attaching.resolve()
        await proceed.promise
        await process.initialize()
      },
    }
  }
  const stores = Layer.mergeAll(
    DirectoryStoreLive,
    AgentRunStoreLive,
    KernelSessionStoreLive,
    KernelEventStoreLive,
  ).pipe(
    Layer.provideMerge(
      WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  )
  const resident = ResidentCodexLive(
    { home: root, socket: join(root, "resident.sock") },
    binary,
    { token: "fixture", repositories: [], servers: [], auth: { mode: "token", token: "fixture" } },
    native,
  ).pipe(Layer.provide(Layer.effect(CiService, makeCiStore)))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        const runs = yield* AgentRunStore
        const sessions = yield* KernelSessionStore
        const threads = yield* makeResidentStore
        const at = new Date()
        yield* directory.bindLocalHost("host-a")
        yield* runs.create({
          runId: "restored",
          route: "fixture",
          executorKind: "codex",
          providerId: "native",
          modelId: "same-model",
          agent: "worker",
          repository: "fixture",
          directory: root,
          prompt: "inert",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 1,
          createdAt: at,
        })
        yield* runs.claimSpawn({ runId: "restored", now: at })
        yield* sessions.registerResource({
          resourceId: "restored",
          owningHostId: "host-a",
          absolutePath: root,
          kind: "worktree",
          createdAt: at,
        })
        yield* sessions.registerSession({
          sessionId: "restored",
          nativeSessionId: "thread",
          providerKind: "codex",
          providerVersion: 1,
          providerId: "native",
          serverId: "local",
          owningHostId: "host-a",
          endpointAlias: "local",
          endpointIdentity: "codex-cli://host-a",
          resourceId: "restored",
          createdAt: at,
        })
        yield* threads.attach("restored", "thread", root, "same-model")
        yield* runs.markSpawned({
          runId: "restored",
          resourceId: "restored",
          sessionId: "restored",
          nativeSessionId: "thread",
          now: at,
        })
        yield* runs.markVerified({ runId: "restored", outputTokens: 1, now: at })
        const id = (yield* directory.managed(at, 90_000))[0]?.recipientId
        const pending = yield* Effect.gen(function* () {
          yield* ResidentCodex
          owner.resolve()
          return yield* Effect.never
        }).pipe(Effect.provide(resident), Effect.forkChild)
        yield* Effect.promise(() => attaching.promise)
        expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(false)
        proceed.resolve()
        yield* Effect.promise(() => owner.promise)
        expect((yield* directory.managed(new Date(), 90_000))[0]).toMatchObject({
          recipientId: id,
          status: "active",
          deliverable: true,
        })
        yield* Fiber.interrupt(pending)
        expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(false)
        expect((yield* runs.read("restored"))?.state).toBe("verified")
      }).pipe(Effect.provide(stores), Effect.ensuring(Effect.sync(() => proceed.resolve()))),
    )
  } finally {
    proceed.resolve()
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
