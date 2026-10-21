import { readFile, writeFile } from "node:fs/promises"
import { format, resolveConfig } from "prettier"
import { ModelIdentity } from "../src/execution-selection"
import { toJsonSchemaObject } from "../src/json"

const schemaPath = new URL("../schemas/model-identity.schema.json", import.meta.url)

const modelIdentitySchemaJson = await format(
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/BNasraoui/workflowd/main/schemas/model-identity.schema.json",
    ...toJsonSchemaObject(ModelIdentity),
  }),
  { ...(await resolveConfig(schemaPath)), parser: "json" },
)

if (process.argv.includes("--check")) {
  const existing = await readFile(schemaPath, "utf8").catch(() => "")
  if (existing !== modelIdentitySchemaJson) {
    console.error("Model identity schema is stale. Run: bun run schema:model-identity")
    process.exit(1)
  }
} else {
  await writeFile(schemaPath, modelIdentitySchemaJson)
}
