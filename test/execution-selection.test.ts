import { expect, test } from "bun:test"
import { resolveExecutionSelection } from "../src/execution-selection"
import type {
  ExecutionCapability,
  ExecutionCapabilities,
} from "../src/execution-capability-contract"

const capability = (
  executor: string,
  provider: string | null = "p",
  model = "native",
): ExecutionCapability => ({
  identity: { host: "h", executor, provider, model },
  selectionModel: "picker",
  availability: "available",
  thinking: {
    status: "advertised",
    efforts: [{ id: "xhigh" }],
    variants: [
      {
        id: "deep",
        effort: "provider-max",
        budgets: [{ parameter: "thinkingBudget", value: 8192, unit: "tokens" }],
      },
    ],
  },
  observedAt: "fixture",
})
const listing = (capabilities: ReadonlyArray<ExecutionCapability>): ExecutionCapabilities => ({
  capabilities,
  sources: capabilities.map((c) => ({
    executor: c.identity.executor,
    kind: c.identity.executor.split(":")[0]!,
    protocol: "fixture",
    status: "available",
    checkedAt: "fixture",
    observedAt: "fixture",
    freshUntil: "fixture",
    stale: false,
  })),
})

test("automatic selection is independent of advertisement ordering and prefers native Codex", () => {
  const a = capability("opencode:z"),
    b = capability("codex:local")
  for (const entries of [
    [a, b],
    [b, a],
  ])
    expect(resolveExecutionSelection(listing(entries), { model: "native" })).toMatchObject({
      outcome: "resolved",
      selection: { executor: "codex:local" },
    })
  expect(
    resolveExecutionSelection(listing([a, b]), { model: "native", executor: "opencode:z" }),
  ).toMatchObject({ selection: { executor: "opencode:z" } })
})
test("provider ambiguity and native/catalog collisions require explicit identity", () => {
  const a = capability("opencode:a"),
    b = capability("opencode:b", "other")
  expect(resolveExecutionSelection(listing([a, b]), { model: "native" })).toEqual({
    outcome: "refused",
    reason: "ambiguous_model",
  })
  expect(
    resolveExecutionSelection(listing([a, b]), { model: "native", provider: "p" }),
  ).toMatchObject({ outcome: "resolved", selection: { provider: "p" } })
  expect(
    resolveExecutionSelection(
      listing([a, { ...b, identity: { ...b.identity, model: "other-native" } }]),
      { model: "picker", modelIdentity: "catalog" },
    ),
  ).toMatchObject({ outcome: "refused", reason: "ambiguous_model" })
})
test("available access outranks an unknown native path even with opt-in", () => {
  expect(
    resolveExecutionSelection(
      listing([
        capability("opencode:a"),
        { ...capability("codex:local"), availability: "unknown" },
      ]),
      { model: "native", allowUnknownAccess: true },
    ),
  ).toMatchObject({ selection: { executor: "opencode:a" } })
})
test("exact budget and effort select OpenCode variants without renaming native settings", () => {
  const a = capability("opencode:a")
  expect(
    resolveExecutionSelection(listing([a]), {
      model: "native",
      thinking: { budgets: [{ parameter: "thinkingBudget", value: 8192, unit: "tokens" }] },
    }),
  ).toMatchObject({ selection: { thinking: { variant: "deep", effort: "provider-max" } } })
  for (const thinking of [
    { variant: "wrong" },
    { effort: "wrong" },
    { budgets: [{ parameter: "thinkingBudget", value: 8191, unit: "tokens" }] },
  ])
    expect(resolveExecutionSelection(listing([a]), { model: "native", thinking })).toMatchObject({
      outcome: "refused",
      reason: "unsupported_thinking",
    })
})
test("Codex refuses variants and budgets and unsupported native efforts", () => {
  const a = capability("codex:local")
  for (const thinking of [{ variant: "deep" }, { budgets: [] }, { effort: "wrong" }])
    expect(resolveExecutionSelection(listing([a]), { model: "native", thinking })).toMatchObject({
      outcome: "refused",
      reason: "unsupported_thinking",
    })
})
test("unavailable executors never launch; unknown providers remain null", () => {
  expect(
    resolveExecutionSelection(
      { sources: [], capabilities: [] },
      { model: "native", executor: "codex:local" },
    ),
  ).toEqual({ outcome: "refused", reason: "executor_unavailable" })
  expect(
    resolveExecutionSelection(listing([capability("codex:local", null)]), {
      model: "native",
      provider: null,
    }),
  ).toMatchObject({ selection: { provider: null } })
})

test("a stale or unavailable source is an executor refusal even if a model is retained", () => {
  for (const source of [{ stale: true }, { status: "unavailable" as const }]) {
    const catalog = listing([capability("codex:local")])
    expect(
      resolveExecutionSelection(
        { ...catalog, sources: catalog.sources.map((s) => ({ ...s, ...source })) },
        { model: "native", executor: "codex:local" },
      ),
    ).toEqual({ outcome: "refused", reason: "executor_unavailable" })
  }
})
