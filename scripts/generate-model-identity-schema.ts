import { writeFile } from "node:fs/promises"
import { format, resolveConfig } from "prettier"
import { ModelIdentity } from "../src/execution-selection"
import { toJsonSchemaObject } from "../src/json"

const schemaPath = new URL("../schemas/model-identity.schema.json", import.meta.url)

export const modelIdentitySchemaJson = await format(
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/BNasraoui/workflowd/main/schemas/model-identity.schema.json",
    ...toJsonSchemaObject(ModelIdentity),
  }),
  { ...(await resolveConfig(schemaPath)), parser: "json" },
)

if (import.meta.main) {
  await writeFile(schemaPath, modelIdentitySchemaJson)
}
