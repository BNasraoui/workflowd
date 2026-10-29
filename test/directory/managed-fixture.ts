import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { DirectoryStoreLive } from "../../src/directory/store"
import { DirectoryRemoteStoreLive } from "../../src/directory/remote-store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { WorkflowStoreLive } from "../../src/store"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"

export const managedStores = () =>
  Layer.mergeAll(
    DirectoryStoreLive,
    DirectoryRemoteStoreLive,
    AgentRunStoreLive,
    KernelSessionStoreLive,
    KernelEventStoreLive,
    Layer.effect(CiService, makeCiStore),
  ).pipe(
    Layer.provideMerge(
      WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  )

export const seedManaged = (
  runId: string,
  at: Date,
  endpoint: string,
  kind: "opencode" | "codex" = "opencode",
  directory = `/fixture/${runId}`,
) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    const sessions = yield* KernelSessionStore
    yield* runs.create({
      runId,
      executorKind: kind,
      route: "fixture",
      providerId: "fixture",
      modelId: "same-model",
      agent: "worker",
      repository: "fixture",
      directory,
      prompt: "inert",
      promptSha256: "a".repeat(64),
      parentSessionId: null,
      resumePrompt: null,
      maxAttempts: 2,
      createdAt: at,
    })
    yield* runs.claimSpawn({ runId, now: at })
    yield* sessions.registerResource({
      resourceId: runId,
      owningHostId: "host-a",
      absolutePath: directory,
      kind: "worktree",
      createdAt: at,
    })
    yield* sessions.registerSession({
      sessionId: runId,
      nativeSessionId: `ses_${runId}`,
      providerKind: kind,
      providerVersion: 1,
      providerId: "fixture",
      serverId: "fixture",
      owningHostId: "host-a",
      endpointAlias: "local",
      endpointIdentity: endpoint,
      resourceId: runId,
      createdAt: at,
    })
    yield* runs.markSpawned({
      runId,
      resourceId: runId,
      sessionId: runId,
      nativeSessionId: `ses_${runId}`,
      now: at,
    })
    yield* runs.markVerified({ runId, outputTokens: 1, now: at })
  })
