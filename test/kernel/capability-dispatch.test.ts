import { expect, test } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import type { ExecutionCapabilities } from "../../src/execution-capability-contract"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { AgentRunStoreConflictError } from "../../src/kernel/agent-run-store"
import {
  defaultState,
  makeCodexCli,
  makeLayer,
  makeProvider,
  register,
  refusalOf,
  worktrees,
} from "./agent-run-ingress-harness"

const at = "2026-10-01T00:00:00.000Z"
const catalog: ExecutionCapabilities = {
  sources: [
    {
      executor: "opencode:primary",
      kind: "opencode",
      protocol: "fixture",
      status: "available",
      checkedAt: at,
      observedAt: at,
      freshUntil: at,
      stale: false,
    },
  ],
  capabilities: [
    {
      identity: {
        host: "mint",
        executor: "opencode:primary",
        provider: "anthropic",
        model: "native-new",
      },
      selectionModel: "catalog-new",
      availability: "available",
      observedAt: at,
      thinking: {
        status: "advertised",
        variants: [
          {
            id: "deep",
            effort: "maximal",
            budgets: [{ parameter: "thinking.budgetTokens", value: 9000, unit: "tokens" }],
          },
        ],
      },
    },
  ],
}
const input = {
  model: "native-new",
  provider: "anthropic",
  repository: "workflowd",
  prompt: "Fix it",
  thinking: { variant: "deep" },
}
const setup = (listing = catalog) => {
  const state = defaultState()
  const trees: Array<{ repository: string; directory: string; branch: string }> = []
  const layer = makeLayer(makeProvider(state), worktrees(trees)).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  return { state, trees, layer }
}

const awaitCompletion = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    return yield* store.read(runId).pipe(
      Effect.repeat({
        until: (row) => row?.state === "completed",
        schedule: Schedule.spaced("5 millis"),
      }),
      Effect.timeout("1 second"),
    )
  })

test("family dispatch freezes the selected release through catalog refresh and duplicate calls", async () => {
  let model = "claude-opus-5-5"
  const state = defaultState()
  const layer = makeLayer(makeProvider(state), worktrees([])).pipe(
    Layer.provideMerge(
      Layer.succeed(ExecutionDiscovery, {
        list: () =>
          Effect.succeed({
            ...catalog,
            capabilities: catalog.capabilities.map((c) => ({
              ...c,
              identity: { ...c.identity, model },
              selectionModel: model,
            })),
          }),
      }),
    ),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const request = {
        family: "opus",
        harness: "opencode" as const,
        host: "mint",
        repository: "workflowd",
        prompt: "Fix the bug",
        idempotencyKey: "family-key",
      }
      const first = yield* register(request)
      model = "claude-opus-6"
      const duplicate = yield* register(request)
      const store = yield* AgentRunStore
      return { first, duplicate, row: yield* store.read(first.runId) }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.first.resolvedSelection).toMatchObject({
    model: "claude-opus-5-5",
    family: "opus",
    version: "5.5",
  })
  expect(result.duplicate.resolvedSelection).toEqual(result.first.resolvedSelection)
  expect(result.row?.requestedSelection).toMatchObject({
    family: "opus",
    host: "mint",
    harness: "opencode",
  })
  expect(state.created).toHaveLength(1)
})

test("duplicate receipts retain the accepted executor after discovery becomes unavailable", async () => {
  let listing = catalog
  const state = defaultState()
  const layer = makeLayer(makeProvider(state), worktrees([])).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* register(input)
      listing = { sources: [], capabilities: [] }
      const duplicate = yield* register(input)
      return { first, duplicate }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.duplicate.status).toBe("duplicate")
  expect(result.duplicate.resolvedSelection).toEqual(result.first.resolvedSelection)
  expect(state.created).toHaveLength(1)
})

test("unaliased native model dispatch persists native and catalog identities and exact thinking", async () => {
  const { state, layer } = setup()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register(input)
      const store = yield* AgentRunStore
      return { receipt, run: yield* store.read(receipt.runId) }
    }).pipe(Effect.provide(layer)),
  )
  expect(state.created[0]?.model).toEqual({
    providerID: "anthropic",
    modelID: "catalog-new",
    variant: "deep",
  })
  expect(result.receipt.resolvedSelection).toMatchObject({
    executorKind: "opencode",
    provider: "anthropic",
    model: "native-new",
    selectionModel: "catalog-new",
    thinking: {
      variant: "deep",
      effort: "maximal",
      budgets: [{ parameter: "thinking.budgetTokens", value: 9000, unit: "tokens" }],
    },
  })
  expect(result.run?.resolvedSelection).toEqual(result.receipt.resolvedSelection)
  expect(result.run?.requestedSelection).toMatchObject({
    model: "native-new",
    thinking: { variant: "deep" },
  })
})

test("catalog identity is explicit and does not accidentally match a native ID", async () => {
  const { layer } = setup()
  expect(
    (
      await refusalOf(
        Effect.runPromise(register({ ...input, model: "catalog-new" }).pipe(Effect.provide(layer))),
      )
    ).reason,
  ).toBe("unknown_model")
  const receipt = await Effect.runPromise(
    register({ ...input, model: "catalog-new", modelIdentity: "catalog" }).pipe(
      Effect.provide(layer),
    ),
  )
  expect(receipt.resolvedSelection?.model).toBe("native-new")
})

for (const availability of ["unknown", "unavailable"] as const)
  test(`explicit ${availability} access refuses before worktree creation`, async () => {
    const { layer, trees } = setup({
      ...catalog,
      capabilities: catalog.capabilities.map((c) => ({ ...c, availability })),
    })
    const refusal = await refusalOf(Effect.runPromise(register(input).pipe(Effect.provide(layer))))
    expect(refusal.reason).toBe(
      availability === "unknown" ? "model_access_unknown" : "model_not_available",
    )
    expect(trees).toHaveLength(0)
  })

test("unsupported thinking is refused before launch", async () => {
  const { layer, state } = setup()
  expect(
    (
      await refusalOf(
        Effect.runPromise(
          register({ ...input, thinking: { effort: "imaginary" } }).pipe(Effect.provide(layer)),
        ),
      )
    ).reason,
  ).toBe("unsupported_thinking")
  expect(state.created).toHaveLength(0)
})

test("a common-catalog family cannot launch on another host without remote transport", async () => {
  const state = defaultState()
  const trees: Array<{ repository: string; directory: string; branch: string }> = []
  const listing: ExecutionCapabilities = {
    sources: [{ ...catalog.sources[0]!, host: "mint", executor: "codex:local", kind: "codex" }],
    capabilities: [
      {
        ...catalog.capabilities[0]!,
        identity: { host: "mint", executor: "codex:local", provider: "openai", model: "gpt-6-sol" },
      },
    ],
  }
  const cli = makeCodexCli([])
  const layer = makeLayer(makeProvider(state), worktrees(trees), cli.port).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const outcome = yield* register({
        family: "sol",
        host: "other",
        repository: "workflowd",
        prompt: "Fix",
      }).pipe(Effect.result)
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT run_id FROM kernel_agent_runs`
      return { outcome, rows }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.outcome._tag).toBe("Failure")
  if (result.outcome._tag === "Failure")
    expect(result.outcome.failure).toMatchObject({
      reason: "host_unavailable",
      detail: expect.stringContaining("remote launch"),
    })
  expect(result.rows).toHaveLength(0)
  expect(trees).toHaveLength(0)
  expect(cli.state.spawned).toHaveLength(0)
  expect(state.created).toHaveLength(0)
})

test("numeric native budgets select an exact variant without route-storage limits", async () => {
  const { layer } = setup()
  const receipt = await Effect.runPromise(
    register({
      ...input,
      thinking: {
        effort: "maximal",
        budgets: [{ parameter: "thinking.budgetTokens", value: 9000, unit: "tokens" }],
      },
    }).pipe(Effect.provide(layer)),
  )
  expect(receipt.resolvedSelection?.thinking.variant).toBe("deep")
})

test("same idempotency key cannot reuse a different thinking selection", async () => {
  const { layer } = setup()
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      yield* register({ ...input, idempotencyKey: "selection-key" })
      return yield* register({ ...input, thinking: {}, idempotencyKey: "selection-key" }).pipe(
        Effect.result,
      )
    }).pipe(Effect.provide(layer)),
  )
  expect(outcome._tag).toBe("Failure")
  if (outcome._tag === "Failure") expect(outcome.failure).toBeInstanceOf(AgentRunStoreConflictError)
})

test("Codex can be selected automatically with honest unknown access opt-in and native effort", async () => {
  const cli = makeCodexCli([
    { type: "agent_message", text: "OK" },
    { type: "turn.completed", outputTokens: 5 },
  ])
  const listing: ExecutionCapabilities = {
    sources: [{ ...catalog.sources[0]!, executor: "codex:local", kind: "codex" }],
    capabilities: [
      {
        ...catalog.capabilities[0]!,
        identity: { host: "mint", executor: "codex:local", provider: null, model: "new-codex" },
        selectionModel: "codex-catalog",
        availability: "unknown",
        thinking: { status: "advertised", efforts: [{ id: "xhigh" }], defaultEffort: "xhigh" },
      },
    ],
  }
  const state = defaultState()
  const layer = makeLayer(makeProvider(state), worktrees([]), cli.port).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  const receipt = await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register({
        model: "new-codex",
        repository: "workflowd",
        prompt: "Fix",
        allowUnknownAccess: true,
        thinking: { effort: "xhigh" },
      })
      yield* awaitCompletion(receipt.runId)
      return receipt
    }).pipe(Effect.provide(layer)),
  )
  expect(receipt.resolvedSelection).toMatchObject({
    executorKind: "codex",
    provider: null,
    model: "new-codex",
    availability: "unknown",
    thinking: { effort: "xhigh" },
  })
  expect(cli.state.spawned[0]).toMatchObject({ model: "new-codex", effort: "xhigh" })
  expect(state.created).toHaveLength(0)
})

test("a capability dispatch forwards its accepted native speed tier", async () => {
  const cli = makeCodexCli([
    { type: "agent_message", text: "OK" },
    { type: "turn.completed", outputTokens: 5 },
  ])
  const listing: ExecutionCapabilities = {
    sources: [{ ...catalog.sources[0]!, executor: "codex:local", kind: "codex" }],
    capabilities: [
      {
        ...catalog.capabilities[0]!,
        identity: { host: "mint", executor: "codex:local", provider: null, model: "gpt-6-sol" },
        speed: { status: "advertised", tiers: [{ id: "fast", native: "priority" }] },
      },
    ],
  }
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), cli.port).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  const receipt = await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register({
        family: "sol",
        repository: "workflowd",
        prompt: "Fix",
        speed: "fast",
      })
      yield* awaitCompletion(receipt.runId)
      return receipt
    }).pipe(Effect.provide(layer)),
  )
  expect(receipt.resolvedSelection?.speed).toEqual({ id: "fast", native: "priority" })
  expect(cli.state.spawned[0]).toMatchObject({ serviceTier: "priority" })
})

test("Claude CLI help cannot prove exact thinking application for configured aliases", async () => {
  const cli = makeCodexCli([])
  const port = {
    ...cli.port,
    validateEffort: () => Effect.succeed(true),
  }
  const layer = makeLayer(
    makeProvider(defaultState()),
    worktrees([]),
    undefined,
    { claudeRoutes: [{ name: "opus", modelID: "opus" }] },
    port,
  )
  const refusal = await refusalOf(
    Effect.runPromise(
      register({
        route: "opus",
        repository: "workflowd",
        prompt: "Fix",
        thinking: { effort: "xhigh" },
      }).pipe(Effect.provide(layer)),
    ),
  )
  expect(refusal.reason).toBe("unsupported_thinking")
  expect(cli.state.spawned).toHaveLength(0)
})

test("Claude configured alias records its native initialization model", async () => {
  const cli = makeCodexCli([
    { type: "thread.started", threadId: "claude-native", model: "claude-native-model" },
    { type: "agent_message", text: "OK" },
    { type: "turn.completed", outputTokens: 3 },
  ])
  const layer = makeLayer(
    makeProvider(defaultState()),
    worktrees([]),
    undefined,
    { claudeRoutes: [{ name: "opus", modelID: "opus" }] },
    cli.port,
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const request = {
        route: "opus",
        repository: "workflowd",
        prompt: "Fix",
      }
      const receipt = yield* register(request)
      yield* awaitCompletion(receipt.runId)
      const duplicate = yield* register(request)
      return { receipt, duplicate }
    }).pipe(Effect.provide(layer)),
  )
  expect(cli.state.spawned[0]).toMatchObject({ model: "opus" })
  expect(cli.state.spawned[0]?.effort).toBeUndefined()
  expect(result.receipt.resolvedSelection).toMatchObject({
    executorKind: "claude",
    provider: null,
    model: "claude-native-model",
    thinking: {},
    evidence: "runtime",
  })
  expect(result.duplicate.status).toBe("duplicate")
  expect(result.duplicate.resolvedSelection).toEqual(result.receipt.resolvedSelection)
})

test("a native model substitution refuses with custody while preserving the accepted family snapshot", async () => {
  let runId = ""
  const cli = makeCodexCli([
    { type: "thread.started", threadId: "substituted", model: "claude-sonnet-5-5" },
    { type: "agent_message", text: "OK" },
  ])
  const listing: ExecutionCapabilities = {
    sources: [{ ...catalog.sources[0]!, executor: "claude:local", kind: "claude" }],
    capabilities: [
      {
        ...catalog.capabilities[0]!,
        identity: {
          host: "mint",
          executor: "claude:local",
          provider: null,
          model: "claude-opus-5-5",
        },
      },
    ],
  }
  const port = {
    ...cli.port,
    spawn: (input: Parameters<typeof cli.port.spawn>[0]) => {
      runId = input.runId
      return cli.port.spawn(input)
    },
  }
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), undefined, {}, port).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const request = {
        family: "opus",
        repository: "workflowd",
        prompt: "Fix",
        idempotencyKey: "substitution",
      }
      const outcome = yield* register(request).pipe(Effect.result)
      const replay = yield* register(request).pipe(Effect.result)
      const store = yield* AgentRunStore
      const row = yield* store.read(runId)
      const sql = yield* SqlClient.SqlClient
      const messages = yield* sql<{ prompt: string }>`SELECT prompt FROM resident_inbox
        WHERE mailbox_id = ${row!.callerMailboxId}`
      return { outcome, replay, row, messages }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.outcome._tag).toBe("Failure")
  if (result.outcome._tag === "Failure")
    expect(result.outcome.failure).toMatchObject({
      reason: "model_not_available",
      mailboxId: result.row?.callerMailboxId,
    })
  expect(result.replay._tag).toBe("Failure")
  if (result.replay._tag === "Failure")
    expect(result.replay.failure).toMatchObject({
      reason: "run_conflict",
      mailboxId: result.row?.callerMailboxId,
    })
  expect(result.messages).toHaveLength(1)
  expect(JSON.parse(result.messages[0]!.prompt)).toMatchObject({
    run_id: runId,
    status: "operator_required",
    model: "claude-opus-5-5",
    end_reason: expect.stringContaining("selection_mismatch"),
  })
  expect(cli.state.spawned).toHaveLength(1)
  expect(cli.state.killed).toBe(true)
  expect(result.row).toMatchObject({
    state: "operator_required",
    nativeSessionId: "substituted",
    resolvedSelection: { model: "claude-opus-5-5", evidence: "advertised" },
  })
  expect(result.row?.diagnostic).toContain("claude-sonnet-5-5")
})
