import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { Schema } from "effect"
import { ModelIdentity } from "../src/execution-selection"
import { modelIdentitySchemaJson } from "../scripts/generate-model-identity-schema"

const schemaFile = Bun.file(new URL("../schemas/model-identity.schema.json", import.meta.url))

test("the committed schema matches the generated Effect schema", async () => {
  expect(await schemaFile.text()).toBe(modelIdentitySchemaJson)
})

test("the published model identity schema validates live examples for every executor kind", async () => {
  expect(await schemaFile.exists()).toBe(true)
  const schema = await schemaFile.json()
  const validate = new Ajv2020().compile(schema)
  for (const kind of ["codex", "opencode", "claude"]) {
    const example: unknown = await Bun.file(
      new URL(`../schemas/examples/model-identity.${kind}.json`, import.meta.url),
    ).json()
    expect(Schema.decodeUnknownSync(ModelIdentity)(example).executorKind).toBe(kind)
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
  for (const field of Object.keys(identity)) {
    const incomplete: Record<string, unknown> = { ...identity }
    delete incomplete[field]
    expect(validate(incomplete)).toBe(false)
  }
  expect(validate({ ...identity, executorKind: "unknown" })).toBe(false)
  expect(validate({ ...identity, provider: 123 })).toBe(false)
  expect(validate({ ...identity, host: "mint" })).toBe(false)
})
