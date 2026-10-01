import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { AgentRunReceipt } from "../../src/agent-run-contract"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { routeRequest } from "../../src/http"
import { AgentRunIngress, agentRunIdentifiers } from "../../src/kernel/agent-run-ingress"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { at, defaultState, makeLayer, makeProvider, worktrees } from "./agent-run-ingress-harness"
const Refusal = Schema.Struct({ reason: Schema.String, detail: Schema.String })
const options = { routes: [], codexRoutes: [], claudeRoutes: [] }
const call = (input: unknown) =>
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    return yield* routeRequest(
      new Request("http://fixture/workflows/agent-runs", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify(input),
      }),
      { webhookSecret: "", now: at, agentRuns: { token: "secret", ...ingress } },
    )
  })
for (const state of ["accepted", "spawning", "spawned", "verified", "completed"] as const)
  test(`stored Claude ${state} replay with disabled executor is immutable or explicitly unavailable`, async () => {
    let catalogReads = 0
    const provider = defaultState()
    const layer = makeLayer(makeProvider(provider), worktrees([]), undefined, options, null).pipe(
      Layer.provideMerge(
        Layer.succeed(ExecutionDiscovery, {
          list: () =>
            Effect.sync(() => {
              catalogReads++
              return { sources: [], capabilities: [] }
            }),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = {
          route: "previous-claude",
          repository: "workflowd",
          prompt: "original",
          idempotencyKey: "disabled",
        }
        const ids = agentRunIdentifiers({ ...input, parentSessionId: null, resumePrompt: null })
        const store = yield* AgentRunStore
        const selection = {
          host: "mint",
          executor: "claude:local",
          executorKind: "claude" as const,
          provider: null,
          model: "native-original",
          selectionModel: "native-original",
          thinking: {},
          availability: "unknown" as const,
          evidence: "runtime" as const,
        }
        yield* store.create({
          runId: ids.runId,
          route: input.route,
          providerId: "claude-cli",
          modelId: "native-original",
          executorKind: "claude",
          requestedSelection: { route: input.route },
          resolvedSelection: selection,
          agent: "build",
          repository: input.repository,
          directory: "/old",
          prompt: input.prompt,
          promptSha256: createHash("sha256").update(input.prompt).digest("hex"),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 3,
          createdAt: at,
        })
        if (state !== "accepted") yield* store.claimSpawn({ runId: ids.runId, now: at })
        if (["spawned", "verified", "completed"].includes(state)) {
          const sessions = yield* KernelSessionStore
          yield* sessions.registerResource({
            resourceId: "old-resource",
            owningHostId: "mint",
            absolutePath: "/old",
            kind: "worktree",
            createdAt: at,
          })
          yield* sessions.registerSession({
            sessionId: "claude-session-old",
            providerKind: "claude",
            providerVersion: 1,
            providerId: "claude-cli",
            serverId: "mint",
            owningHostId: "mint",
            endpointAlias: "local",
            endpointIdentity: "claude-cli://mint",
            nativeSessionId: "old-native",
            resourceId: "old-resource",
            createdAt: at,
          })
        }
        if (["spawned", "verified", "completed"].includes(state))
          yield* store.markSpawned({
            runId: ids.runId,
            now: at,
            resourceId: "old-resource",
            sessionId: "claude-session-old",
            nativeSessionId: "old-native",
          })
        if (["verified", "completed"].includes(state))
          yield* store.markVerified({ runId: ids.runId, now: at, outputTokens: 7 })
        if (state === "completed") yield* store.complete({ runId: ids.runId, now: at })
        const before = yield* store.read(ids.runId)
        const response = yield* call(input)
        if (state === "verified" || state === "completed") {
          expect(response.status).toBe(202)
          const receipt = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AgentRunReceipt)),
          )
          expect(receipt).toMatchObject({
            status: "duplicate",
            nativeSessionId: "old-native",
            modelId: "native-original",
            resolvedSelection: selection,
          })
        } else {
          expect(response.status).toBe(409)
          const issue = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
          )
          expect(issue).toMatchObject({
            reason: "executor_unavailable",
            detail: expect.stringContaining("disabled"),
          })
        }
        expect(yield* store.read(ids.runId)).toEqual(before)
        expect(catalogReads).toBe(0)
        expect(provider.created).toHaveLength(0)
      }).pipe(Effect.provide(layer)),
    )
  })

test("thinking on a CLI default alias truthfully refuses unsupported thinking before discovery or launch", async () => {
  let reads = 0
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), undefined, {
    ...options,
    codexRoutes: [{ name: "default", modelID: null }],
  }).pipe(
    Layer.provideMerge(
      Layer.succeed(ExecutionDiscovery, {
        list: () =>
          Effect.sync(() => {
            reads++
            return {
              sources: [
                {
                  executor: "codex:local",
                  kind: "codex",
                  protocol: "fixture",
                  status: "available",
                  checkedAt: at.toISOString(),
                  observedAt: at.toISOString(),
                  freshUntil: at.toISOString(),
                  stale: false,
                },
              ],
              capabilities: [],
            }
          }),
      }),
    ),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* call({
        route: "default",
        repository: "workflowd",
        prompt: "default",
        thinking: { effort: "xhigh" },
      })
      expect(response.status).toBe(409)
      const issue = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
      )
      expect(issue).toMatchObject({
        reason: "unsupported_thinking",
        detail: expect.stringContaining("model"),
      })
      expect(reads).toBe(0)
    }).pipe(Effect.provide(layer)),
  )
})
