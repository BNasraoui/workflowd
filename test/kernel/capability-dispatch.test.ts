import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
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
    register({
      model: "new-codex",
      repository: "workflowd",
      prompt: "Fix",
      allowUnknownAccess: true,
      thinking: { effort: "xhigh" },
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

const claudeRoutes = [{ name: "claude-fable", modelID: "claude-fable-5-1" }]
const claudeListing: ExecutionCapabilities = {
  sources: [
    {
      executor: "claude:local",
      kind: "claude",
      protocol: "unsupported",
      status: "unsupported",
      checkedAt: at,
      observedAt: null,
      freshUntil: null,
      stale: false,
    },
  ],
  capabilities: [],
}
const claudeSetup = (
  cli = makeCodexCli([{ type: "agent_message", text: "OK" }]),
  listing = claudeListing,
) => {
  const state = defaultState()
  const layer = makeLayer(
    makeProvider(state),
    worktrees([]),
    undefined,
    { claudeRoutes },
    cli.port,
  ).pipe(
    Layer.provideMerge(Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing) })),
  )
  return { cli, state, layer }
}
const openCodeSource = catalog.sources[0]!
const openCodeClaude = {
  ...catalog.capabilities[0]!,
  identity: {
    host: "mint",
    executor: "opencode:primary",
    provider: "anthropic",
    model: "claude-fable-5-2",
  },
  selectionModel: "claude-fable-5-2",
  thinking: { status: "unknown" as const },
}
const claudeRequest = { repository: "workflowd", prompt: "Fix" }

test("a configured Claude alias passes the requested effort to the claude command line", async () => {
  const { cli, layer } = claudeSetup()
  const receipt = await Effect.runPromise(
    register({ ...claudeRequest, route: "claude-fable", thinking: { effort: "xhigh" } }).pipe(
      Effect.provide(layer),
    ),
  )
  expect(cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-1", effort: "xhigh" })
  expect(receipt.requestedSelection?.thinking).toEqual({ effort: "xhigh" })
  expect(receipt.resolvedSelection).toMatchObject({
    executor: "claude:local",
    executorKind: "claude",
    model: "claude-fable-5-1",
    thinking: { effort: "xhigh" },
    evidence: "configured",
  })
})

for (const field of ["model", "route"] as const)
  test(`an unlisted Claude model id given as ${field} reaches the command line as given`, async () => {
    const { cli, layer } = claudeSetup()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const receipt = yield* register({
          ...claudeRequest,
          [field]: "claude-fable-5-2",
          thinking: { effort: "xhigh" },
        })
        const store = yield* AgentRunStore
        return { receipt, run: yield* store.read(receipt.runId) }
      }).pipe(Effect.provide(layer)),
    )
    expect(cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-2", effort: "xhigh" })
    expect(result.receipt.providerId).toBe("claude-cli")
    expect(result.receipt.modelId).toBe("claude-fable-5-2")
    expect(result.receipt.resolvedSelection).toMatchObject({
      executor: "claude:local",
      executorKind: "claude",
      provider: null,
      model: "claude-fable-5-2",
      selectionModel: "claude-fable-5-2",
      thinking: { effort: "xhigh" },
      availability: "unknown",
      evidence: "requested",
    })
    expect(result.run?.resolvedSelection).toEqual(result.receipt.resolvedSelection)
  })

test("an explicit Claude executor runs on Claude without reading capability discovery", async () => {
  const cli = makeCodexCli([{ type: "agent_message", text: "OK" }])
  const layer = makeLayer(
    makeProvider(defaultState()),
    worktrees([]),
    undefined,
    { claudeRoutes },
    cli.port,
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(ExecutionDiscovery, {
        list: () => Effect.fail(new Error("discovery must not be read")),
      }),
    ),
  )
  const receipt = await Effect.runPromise(
    register({ ...claudeRequest, model: "claude-fable-5-2", executor: "claude:local" }).pipe(
      Effect.provide(layer),
    ),
  )
  expect(cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-2" })
  expect(receipt.resolvedSelection).toMatchObject({ executor: "claude:local" })
})

test("an explicit Claude executor skips a catalog that serves the same model id", async () => {
  const { cli, state, layer } = claudeSetup(undefined, {
    sources: [...claudeListing.sources, openCodeSource],
    capabilities: [openCodeClaude],
  })
  const receipt = await Effect.runPromise(
    register({ ...claudeRequest, model: "claude-fable-5-2", executor: "claude:local" }).pipe(
      Effect.provide(layer),
    ),
  )
  expect(cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-2" })
  expect(cli.state.spawned[0]?.effort).toBeUndefined()
  expect(state.created).toHaveLength(0)
  expect(receipt.resolvedSelection).toMatchObject({
    executor: "claude:local",
    evidence: "requested",
  })
})

test("a catalog that serves a claude- model id comes before the Claude CLI", async () => {
  const { cli, state, layer } = claudeSetup(undefined, {
    sources: [...claudeListing.sources, openCodeSource],
    capabilities: [openCodeClaude],
  })
  const receipt = await Effect.runPromise(
    register({ ...claudeRequest, model: "claude-fable-5-2" }).pipe(Effect.provide(layer)),
  )
  expect(cli.state.spawned).toHaveLength(0)
  expect(state.created).toHaveLength(1)
  expect(receipt.resolvedSelection).toMatchObject({
    executor: "opencode:primary",
    evidence: "advertised",
  })
})

for (const [label, down] of [
  ["unavailable", { ...openCodeSource, status: "unavailable" as const, stale: true }],
  ["unauthenticated", { ...openCodeSource, status: "unauthenticated" as const, stale: true }],
  ["out of date", { ...openCodeSource, stale: true }],
] as const)
  test(`a claude- model id is refused, not moved to Claude, while a catalog source is ${label}`, async () => {
    const listing = { sources: [...claudeListing.sources, down], capabilities: [] }
    const { cli, state, layer } = claudeSetup(undefined, listing)
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ ...claudeRequest, model: "claude-fable-5-2" }).pipe(Effect.provide(layer)),
      ),
    )
    expect(refusal.reason).toBe("executor_unavailable")
    expect(refusal.detail).toContain(`opencode:primary is ${label}`)
    expect(refusal.detail).toContain('executor "claude:local"')
    expect(cli.state.spawned).toHaveLength(0)
    expect(state.created).toHaveLength(0)
    for (const request of [
      { model: "claude-fable-5-2", executor: "claude:local" },
      { route: "claude-fable-5-2" },
    ]) {
      const named = claudeSetup(undefined, listing)
      await Effect.runPromise(
        register({ ...claudeRequest, ...request }).pipe(Effect.provide(named.layer)),
      )
      expect(named.cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-2" })
    }
  })

for (const status of ["unauthenticated", "unavailable"] as const)
  test(`a Codex source that is ${status} does not keep a claude- model id off Claude`, async () => {
    const codexSource = {
      executor: "codex:local",
      kind: "codex",
      protocol: "codex-app-server/model/list",
      status,
      checkedAt: at,
      observedAt: at,
      freshUntil: at,
      stale: true,
    }
    const { cli, state, layer } = claudeSetup(undefined, {
      sources: [...claudeListing.sources, codexSource],
      capabilities: [],
    })
    const receipt = await Effect.runPromise(
      register({ ...claudeRequest, model: "claude-fable-5-2", thinking: { effort: "xhigh" } }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-2", effort: "xhigh" })
    expect(state.created).toHaveLength(0)
    expect(receipt.resolvedSelection).toMatchObject({
      executor: "claude:local",
      evidence: "requested",
    })
  })

for (const requested of ["claude-fable", "claude-fable-5-1"])
  test(`a configured Claude route is matched when model names its ${requested === "claude-fable" ? "alias" : "model id"}`, async () => {
    const { cli, layer } = claudeSetup()
    const receipt = await Effect.runPromise(
      register({ ...claudeRequest, model: requested }).pipe(Effect.provide(layer)),
    )
    expect(cli.state.spawned[0]).toMatchObject({ model: "claude-fable-5-1" })
    expect(receipt.resolvedSelection).toMatchObject({
      model: "claude-fable-5-1",
      evidence: "configured",
    })
  })

test("provider-prefixed Claude ids are still refused for the Claude executor", async () => {
  const { cli, layer } = claudeSetup()
  expect(
    (
      await refusalOf(
        Effect.runPromise(
          register({ ...claudeRequest, route: "anthropic/claude-fable-5-2" }).pipe(
            Effect.provide(layer),
          ),
        ),
      )
    ).reason,
  ).toBe("provider_prefixed_route")
  for (const [request, reason] of [
    [{ model: "anthropic/claude-fable-5-2" }, "unknown_model"],
    [{ model: "anthropic/claude-fable-5-2", executor: "claude:local" }, "provider_prefixed_route"],
    [
      { model: "claude-fable-5-2", provider: "anthropic", executor: "claude:local" },
      "executor_unavailable",
    ],
  ] as const)
    expect(
      (
        await refusalOf(
          Effect.runPromise(register({ ...claudeRequest, ...request }).pipe(Effect.provide(layer))),
        )
      ).reason,
    ).toBe(reason)
  expect(cli.state.spawned).toHaveLength(0)
})

test("ids that are not claude- model ids are not passed to the Claude CLI", async () => {
  const { cli, layer } = claudeSetup()
  for (const id of ["claude-", "claude-bad id", `claude-${"x".repeat(130)}`, "opus-5-5"])
    for (const request of [{ route: id }, { model: id, executor: "claude:local" }])
      expect(
        (
          await refusalOf(
            Effect.runPromise(
              register({ ...claudeRequest, ...request }).pipe(Effect.provide(layer)),
            ),
          )
        ).reason,
      ).toBe("unknown_route")
  expect(cli.state.spawned).toHaveLength(0)
})

test("a Claude effort the CLI does not take is refused with a typed reason naming it", async () => {
  const { cli, layer } = claudeSetup()
  for (const request of [
    { route: "claude-fable", thinking: { effort: "turbo" } },
    { model: "claude-fable-5-2", thinking: { effort: "turbo" } },
  ]) {
    const refusal = await refusalOf(
      Effect.runPromise(register({ ...claudeRequest, ...request }).pipe(Effect.provide(layer))),
    )
    expect(refusal.reason).toBe("unsupported_thinking")
    expect(refusal.detail).toContain('"turbo"')
  }
  for (const thinking of [
    { variant: "deep" },
    {
      effort: "high",
      budgets: [{ parameter: "thinking.budgetTokens", value: 9000, unit: "tokens" }],
    },
  ]) {
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ ...claudeRequest, model: "claude-fable-5-2", thinking }).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(refusal.reason).toBe("unsupported_thinking")
    expect(refusal.detail).toContain("variants and budgets")
  }
  expect(cli.state.spawned).toHaveLength(0)
})

test("a Claude effort warning on the CLI stderr fails the run with a typed reason naming it", async () => {
  const { cli, layer } = claudeSetup(
    makeCodexCli(
      [],
      143,
      undefined,
      undefined,
      "Warning: Unknown --effort value 'max' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh.\n",
    ),
  )
  const refusal = await refusalOf(
    Effect.runPromise(
      register({ ...claudeRequest, model: "claude-fable-5-2", thinking: { effort: "max" } }).pipe(
        Effect.provide(layer),
      ),
    ),
  )
  expect(cli.state.spawned[0]).toMatchObject({ effort: "max" })
  expect(refusal.reason).toBe("unsupported_thinking")
  expect(refusal.detail).toContain("'max'")
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

test("the Claude effort warning is not read from another CLI's stderr", async () => {
  const cli = makeCodexCli(
    [],
    1,
    undefined,
    undefined,
    "Unknown --effort value 'max' — ignoring it and using the default effort.\n",
  )
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), cli.port, {
    codexRoutes: [{ name: "scan", modelID: "native" }],
  })
  const refusal = await refusalOf(
    Effect.runPromise(register({ ...claudeRequest, route: "scan" }).pipe(Effect.provide(layer))),
  )
  expect(cli.state.spawned).toHaveLength(1)
  expect(refusal.reason).toBe("no_first_token")
  expect(refusal.detail).toStartWith("codex exited before producing model output")
})
