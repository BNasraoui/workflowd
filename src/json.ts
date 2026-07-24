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
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record({ key: Schema.String, value: JsonValueSchema }),
  ),
)

export const JsonText = Schema.parseJson(JsonValueSchema)
