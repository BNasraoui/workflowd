import { expect, test } from "bun:test"
import type { ExecutionCapabilities } from "../../src/execution-capability-contract"
import { resolveExecutionSelection } from "../../src/execution-selection"
import { listModels } from "../../src/execution/models"

const catalog = (
  models: ReadonlyArray<{ model: string; harness?: string; host?: string }>,
): ExecutionCapabilities => ({
  capabilities: models.map(({ model, harness = "codex", host = "mint" }) => ({
    identity: {
      host,
      executor: `${harness}:local`,
      provider: harness === "codex" ? "openai" : "anthropic",
      model,
    },
    selectionModel: model,
    availability: "available",
    thinking: { status: "advertised", efforts: [{ id: "high" }] },
    observedAt: "2026-10-04T00:00:00Z",
  })),
  sources: models.map(({ harness = "codex" }) => ({
    executor: `${harness}:local`,
    kind: harness,
    protocol: "fixture",
    status: "available",
    checkedAt: "2026-10-04T00:00:00Z",
    observedAt: "2026-10-04T00:00:00Z",
    freshUntil: "2026-10-04T00:01:00Z",
    stale: false,
  })),
})

test("family selection picks the newest numeric release independently of catalog order", () => {
  const models = [{ model: "gpt-6.9-sol" }, { model: "gpt-6.10-sol" }, { model: "gpt-6-sol" }]
  for (const entries of [models, [...models].reverse()])
    expect(
      resolveExecutionSelection(catalog(entries), { family: "sol", host: "mint" }),
    ).toMatchObject({
      outcome: "resolved",
      selection: { model: "gpt-6.10-sol", executorKind: "codex", family: "sol", version: "6.10" },
    })
})

test("an explicit harness scopes latest before choosing a release", () => {
  expect(
    resolveExecutionSelection(
      catalog([{ model: "gpt-6.10-sol", harness: "opencode" }, { model: "gpt-6.9-sol" }]),
      { family: "sol", harness: "codex" },
    ),
  ).toMatchObject({
    outcome: "resolved",
    selection: { model: "gpt-6.9-sol", executorKind: "codex" },
  })
})

test("Claude families prefer Claude rather than a newer OpenCode release", () => {
  expect(
    resolveExecutionSelection(
      catalog([
        { model: "claude-opus-5-5", harness: "claude" },
        { model: "claude-opus-6", harness: "opencode" },
      ]),
      { family: "opus" },
    ),
  ).toMatchObject({
    outcome: "resolved",
    selection: { model: "claude-opus-5-5", executorKind: "claude", version: "5.5" },
  })
})

test("a requested execution host uses the common catalog without fabricating remote observations", () => {
  expect(
    resolveExecutionSelection(catalog([{ model: "gpt-6-sol" }]), { family: "sol", host: "other" }),
  ).toMatchObject({
    outcome: "resolved",
    selection: { host: "other", catalogHost: "mint", model: "gpt-6-sol", executorKind: "codex" },
  })
  expect(listModels(catalog([{ model: "gpt-6-sol" }]), { host: "other" })).toMatchObject({
    models: [{ host: "other", catalogHost: "mint", model: "gpt-6-sol", latest: true }],
    sources: [{ executor: "codex:local" }],
  })
})

test("conflicting selectors and version-without-family refuse", () => {
  for (const request of [
    { family: "sol", model: "gpt-6-sol" },
    { model: "gpt-6-sol", version: "6" },
  ])
    expect(resolveExecutionSelection(catalog([{ model: "gpt-6-sol" }]), request)).toEqual({
      outcome: "refused",
      reason: "invalid_selection",
    })
})

test("version pins refuse rather than selecting another version", () => {
  const listing = catalog([{ model: "gpt-6.9-sol" }, { model: "gpt-6.10-sol" }])
  expect(resolveExecutionSelection(listing, { family: "sol", version: "6.9" })).toMatchObject({
    selection: { model: "gpt-6.9-sol" },
  })
  expect(resolveExecutionSelection(listing, { family: "sol", version: "7" })).toEqual({
    outcome: "refused",
    reason: "unsupported_version",
  })
})

test("unknown names and preview IDs never imply family membership", () => {
  for (const model of ["my-sol-model", "gpt-6-sol-preview", "other-claude-opus-6"])
    expect(resolveExecutionSelection(catalog([{ model }]), { family: "sol" })).toEqual({
      outcome: "refused",
      reason: "unknown_family",
    })
})

test("latest refuses unsupported effort instead of downgrading the model", () => {
  const listing = catalog([{ model: "gpt-6.9-sol" }, { model: "gpt-6.10-sol" }])
  expect(
    resolveExecutionSelection(
      {
        ...listing,
        capabilities: listing.capabilities.map((c) => ({
          ...c,
          thinking: {
            status: "advertised",
            efforts: c.identity.model === "gpt-6.9-sol" ? [{ id: "max" }] : [],
          },
        })),
      },
      { family: "sol", thinking: { effort: "max" } },
    ),
  ).toEqual({ outcome: "refused", reason: "unsupported_thinking" })
})

test("intent presets supply defaults while explicit family choices win", () => {
  const policy = {
    revision: "fixture-1",
    intents: [{ name: "research", family: "sol", thinking: { effort: "high" } }],
  }
  const listing = catalog([{ model: "gpt-6-sol" }, { model: "claude-opus-5-5", harness: "claude" }])
  expect(resolveExecutionSelection(listing, { intent: "research" }, policy)).toMatchObject({
    selection: { model: "gpt-6-sol", thinking: { effort: "high" }, policyRevision: "fixture-1" },
  })
  expect(
    resolveExecutionSelection(
      listing,
      { intent: "research", family: "opus", thinking: {} },
      policy,
    ),
  ).toMatchObject({ selection: { model: "claude-opus-5-5" } })
  expect(resolveExecutionSelection(listing, { intent: "missing" }, policy)).toEqual({
    outcome: "refused",
    reason: "unknown_intent",
  })
})

test("custom family mappings select only models actually advertised", () => {
  const policy = {
    revision: "custom-1",
    families: [
      {
        name: "local",
        harness: "codex" as const,
        models: [
          { model: "custom-a", version: "1" },
          { model: "custom-b", version: "2" },
          { model: "phantom", version: "3" },
        ],
      },
    ],
  }
  expect(
    resolveExecutionSelection(
      catalog([{ model: "custom-a" }, { model: "custom-b" }]),
      { family: "local" },
      policy,
    ),
  ).toMatchObject({ selection: { model: "custom-b", family: "local", version: "2" } })
})

test("a configured high-level access default does not weaken exact-ID access checks", () => {
  const listing = catalog([{ model: "gpt-6-sol" }])
  const unknown = {
    ...listing,
    capabilities: listing.capabilities.map((c) => ({ ...c, availability: "unknown" as const })),
  }
  const policy = { revision: "access-1", allowUnknownAccess: true }
  expect(resolveExecutionSelection(unknown, { family: "sol" }, policy)).toMatchObject({
    selection: { availability: "unknown" },
  })
  expect(resolveExecutionSelection(unknown, { model: "gpt-6-sol" }, policy)).toEqual({
    outcome: "refused",
    reason: "model_access_unknown",
  })
  expect(
    resolveExecutionSelection(unknown, { family: "sol", allowUnknownAccess: false }, policy),
  ).toEqual({ outcome: "refused", reason: "model_access_unknown" })
})

test("speed is independent of reasoning and must be advertised", () => {
  const listing = catalog([{ model: "gpt-6-sol" }])
  const supported = {
    ...listing,
    capabilities: listing.capabilities.map((c) => ({
      ...c,
      speed: {
        status: "advertised" as const,
        tiers: [{ id: "standard" }, { id: "fast", native: "priority" }],
      },
    })),
  }
  expect(
    resolveExecutionSelection(supported, {
      family: "sol",
      speed: "fast",
      thinking: { effort: "high" },
    }),
  ).toMatchObject({
    selection: { thinking: { effort: "high" }, speed: { id: "fast", native: "priority" } },
  })
  expect(resolveExecutionSelection(listing, { family: "sol", speed: "fast" })).toEqual({
    outcome: "refused",
    reason: "unsupported_speed",
  })
})

test("Claude effort is opt-in when native caps cannot confirm effective effort", () => {
  const listing = catalog([{ model: "claude-opus-5-5", harness: "claude" }])
  const input = { family: "opus", thinking: { effort: "high" } }
  expect(resolveExecutionSelection(listing, input)).toMatchObject({
    outcome: "refused",
    reason: "unsupported_thinking",
  })
  expect(
    resolveExecutionSelection(listing, input, {
      revision: "claude-1",
      allowUnconfirmedClaudeThinking: true,
    }),
  ).toMatchObject({
    selection: { thinking: { effort: "high" }, thinkingEvidence: "native-unconfirmed" },
  })
})

test("common selection retains the provenance of the healthy source instead of a stale observation", () => {
  const listing = catalog([
    { model: "gpt-6-sol", host: "mint" },
    { model: "gpt-6-sol", host: "other" },
  ])
  const scoped = {
    ...listing,
    sources: listing.sources.map((s, i) => ({
      ...s,
      host: i === 0 ? "mint" : "other",
      stale: i === 0,
    })),
  }
  expect(resolveExecutionSelection(scoped, { family: "sol", host: "mint" })).toMatchObject({
    outcome: "resolved",
    selection: { host: "mint", catalogHost: "other", model: "gpt-6-sol" },
  })
})

test("hidden catalog releases remain exact-addressable but never become automatic latest", () => {
  const listing = catalog([{ model: "gpt-6.9-sol" }, { model: "gpt-6.10-sol" }])
  const hidden = {
    ...listing,
    capabilities: listing.capabilities.map((c) => ({
      ...c,
      pickerEligible: c.identity.model !== "gpt-6.10-sol",
    })),
  }
  expect(resolveExecutionSelection(hidden, { family: "sol" })).toMatchObject({
    selection: { model: "gpt-6.9-sol" },
  })
  expect(resolveExecutionSelection(hidden, { model: "gpt-6.10-sol" })).toMatchObject({
    outcome: "resolved",
  })
  expect(listModels(hidden).models.find((m) => m.model === "gpt-6.10-sol")?.latest).toBe(false)
})

test("unconfirmed Claude effort policy applies to high-level selection without weakening exact IDs", () => {
  const listing = catalog([{ model: "claude-opus-5-5", harness: "claude" }])
  expect(
    resolveExecutionSelection(
      listing,
      { model: "claude-opus-5-5", thinking: { effort: "high" } },
      { revision: "claude-1", allowUnconfirmedClaudeThinking: true },
    ),
  ).toEqual({ outcome: "refused", reason: "unsupported_thinking" })
})

test("accepted native settings retain catalog provenance and distinguish speed from confirmation", () => {
  const listing = catalog([{ model: "gpt-6-sol" }])
  const supported = {
    ...listing,
    capabilities: listing.capabilities.map((c) => ({
      ...c,
      speed: { status: "advertised" as const, tiers: [{ id: "fast", native: "priority" }] },
    })),
  }
  expect(resolveExecutionSelection(supported, { family: "sol", speed: "fast" })).toMatchObject({
    selection: {
      catalogObservedAt: "2026-10-04T00:00:00Z",
      adapterProtocol: "fixture",
      speedEvidence: "native-unconfirmed",
    },
  })
})

test("custom family versions are not ordered across unrelated providers", () => {
  const listing = catalog([{ model: "custom-a" }, { model: "custom-b" }])
  const providers = {
    ...listing,
    capabilities: listing.capabilities.map((c, i) => ({
      ...c,
      identity: { ...c.identity, provider: i === 0 ? "one" : "two" },
    })),
  }
  const policy = {
    revision: "custom",
    families: [
      {
        name: "local",
        harness: "codex" as const,
        models: [
          { model: "custom-a", version: "1" },
          { model: "custom-b", version: "2" },
        ],
      },
    ],
  }
  expect(resolveExecutionSelection(providers, { family: "local" }, policy)).toEqual({
    outcome: "refused",
    reason: "ambiguous_family",
  })
  expect(
    resolveExecutionSelection(providers, { family: "local", provider: "one" }, policy),
  ).toMatchObject({ selection: { model: "custom-a" } })
})

test("compact latest labels do not treat stale sources as eligible releases", () => {
  const listing = catalog([{ model: "gpt-6-sol" }])
  expect(
    listModels({ ...listing, sources: listing.sources.map((s) => ({ ...s, stale: true })) })
      .models[0]?.latest,
  ).toBe(false)
})
