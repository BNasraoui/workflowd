import { Schema } from "effect"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonSerializable =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonSerializable>
  | { readonly [key: string]: JsonSerializable | undefined }

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
)

export const JsonText = Schema.fromJsonString(JsonValueSchema)

export const toJsonSchemaObject = (schema: Schema.Top): object => {
  const document = Schema.toJsonSchemaDocument(schema)
  return {
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  }
}
