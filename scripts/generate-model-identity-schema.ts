import { writeFile } from "node:fs/promises"
import { format } from "prettier"
import { ModelIdentity } from "../src/execution-selection"
import { toJsonSchemaObject } from "../src/json"

export const modelIdentitySchemaJson = await format(
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/BNasraoui/workflowd/main/schemas/model-identity.schema.json",
    ...toJsonSchemaObject(ModelIdentity),
  }),
  { parser: "json" },
)

if (import.meta.main) {
  await writeFile(
    new URL("../schemas/model-identity.schema.json", import.meta.url),
    modelIdentitySchemaJson,
  )
}
