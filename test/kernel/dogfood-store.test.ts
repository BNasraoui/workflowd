import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import {
  DOGFOOD_ENRICHMENT_CONTRACT,
  DogfoodStore,
  DogfoodStoreLive,
} from "../../src/kernel/dogfood-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import {
  agentRunInput,
  at,
  dispatchDirectory,
  insertBlankNativeSession,
  later,
  registerCustody,
} from "./enrichment-fixtures"

const layer = Layer.mergeAll(AgentRunStoreLive, KernelSessionStoreLive, DogfoodStoreLive).pipe(
  Layer.provideMerge(
    WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const dispatchRun = (runId: string, modelId: string, agent: string, spawnedAt: Date) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    yield* runs.create({
      ...agentRunInput({ runId, directory: dispatchDirectory, createdAt: at }),
      modelId,
      agent,
    })
    yield* runs.claimSpawn({ runId, now: at })
    yield* runs.markSpawned({
      runId,
      resourceId: "resource-gpu",
      sessionId: "session-dispatched",
      nativeSessionId: "ses_dispatched",
      worktreeBranch: "agent-run/child",
      now: spawnedAt,
    })
  })

describe("dogfood store", () => {
  test("keys every custody session by native id under the enrichment contract", async () => {
    const document = await run(
      Effect.gen(function* () {
        yield* registerCustody
        yield* dispatchRun("run-1", "zai-coding-plan/glm-5.3-flash", "remote-worker", at)
        const store = yield* DogfoodStore
        return yield* store.sessions()
      }),
    )

    expect(document.contract).toBe(DOGFOOD_ENRICHMENT_CONTRACT)
    expect(document.sessions).toEqual({
      // A session with no agent run omits the run fields instead of nulling them.
      ses_idle: { harness: "opencode", harness_version: 3, machine: "mint" },
      ses_dispatched: {
        harness: "claude",
        harness_version: 1,
        machine: "gpu-box",
        model: "zai-coding-plan/glm-5.3-flash",
        agent: "remote-worker",
        repository: "workflowd",
      },
    })
  })

  test("prefers the most recently updated agent run when runs share a session", async () => {
    const document = await run(
      Effect.gen(function* () {
        yield* registerCustody
        yield* dispatchRun("run-old", "old-provider/old-model", "build", at)
        yield* dispatchRun("run-new", "new-provider/new-model", "review", later)
        const store = yield* DogfoodStore
        return yield* store.sessions()
      }),
    )

    expect(document.sessions.ses_dispatched).toEqual({
      harness: "claude",
      harness_version: 1,
      machine: "gpu-box",
      model: "new-provider/new-model",
      agent: "review",
      repository: "workflowd",
    })
  })

  test("skips sessions whose native session id is empty", async () => {
    const document = await run(
      Effect.gen(function* () {
        yield* registerCustody
        yield* insertBlankNativeSession
        const store = yield* DogfoodStore
        return yield* store.sessions()
      }),
    )

    expect(Object.keys(document.sessions).sort()).toEqual(["ses_dispatched", "ses_idle"])
  })
})
