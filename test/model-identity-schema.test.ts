import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { Schema } from "effect"
import { ModelIdentity, modelIdentityFromRun } from "../src/execution-selection"

const schemaFile = Bun.file(new URL("../schemas/model-identity.schema.json", import.meta.url))
const decodeIdentity = Schema.decodeUnknownSync(ModelIdentity, { onExcessProperty: "error" })

test("the published model identity schema validates live examples for every executor kind", async () => {
  const schema = await schemaFile.json()
  const validate = new Ajv2020().compile(schema)
  for (const kind of ["codex", "opencode", "claude"] as const) {
    const example: unknown = await Bun.file(
      new URL(`../schemas/examples/model-identity.${kind}.json`, import.meta.url),
    ).json()
    expect(decodeIdentity(example).executorKind).toBe(kind)
    expect(validate(example)).toBe(true)
  }
})

test("identity fields are required, nullable IDs stay nullable, and non-identity fields are rejected", async () => {
  const validate = new Ajv2020().compile(await schemaFile.json())
  const identity: ModelIdentity = {
    executor: "claude:local",
    executorKind: "claude",
    provider: null,
    model: null,
    selectionModel: null,
  }
  expect(validate(identity)).toBe(true)
  expect(decodeIdentity(identity)).toEqual(identity)
  for (const field of Object.keys(identity)) {
    const incomplete: Record<string, unknown> = { ...identity }
    delete incomplete[field]
    expect(validate(incomplete)).toBe(false)
    expect(() => decodeIdentity(incomplete)).toThrow()
  }
  for (const invalid of [
    { ...identity, executorKind: "unknown" },
    { ...identity, provider: 123 },
    { ...identity, host: "mint" },
  ]) {
    expect(validate(invalid)).toBe(false)
    expect(() => decodeIdentity(invalid)).toThrow()
  }
})

test("legacy runs retain only the known executor kind and native model", async () => {
  const legacy: unknown = await Bun.file(
    new URL("../schemas/examples/model-identity.legacy.json", import.meta.url),
  ).json()
  expect(new Ajv2020().compile(await schemaFile.json())(legacy)).toBe(true)
  expect(decodeIdentity(legacy).executor).toBeNull()
  for (const executorKind of ["codex", "claude", "opencode"] as const) {
    const run = {
      executorKind,
      modelId: "gpt-6-sol",
      providerId: "codex-cli",
      resolvedSelection: null,
    }
    expect(modelIdentityFromRun(run)).toEqual({
      executor: null,
      executorKind,
      provider: null,
      model: "gpt-6-sol",
      selectionModel: null,
    })
  }
})

test("a resolved selection is authoritative, including unknown fields and catalog IDs", () => {
  const run = {
    executorKind: "codex" as const,
    providerId: "codex-cli",
    modelId: "legacy-model",
    resolvedSelection: {
      host: "mint",
      executor: "codex:local",
      executorKind: "codex" as const,
      provider: null,
      model: null,
      selectionModel: "catalog-model",
      thinking: {},
      availability: "unknown" as const,
      evidence: "advertised" as const,
    },
  }
  expect(modelIdentityFromRun(run)).toEqual({
    executor: "codex:local",
    executorKind: "codex",
    provider: null,
    model: null,
    selectionModel: "catalog-model",
  })
})
