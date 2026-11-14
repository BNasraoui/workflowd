import { Schema } from "effect"

const nonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const NativeControl = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("status") }),
  Schema.Struct({ operation: Schema.Literal("pause"), nonce }),
  Schema.Struct({
    operation: Schema.Literal("finish"),
    nonce,
    revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  }),
  Schema.Struct({
    operation: Schema.Literal("resume"),
    nonce,
    prompt: Schema.NonEmptyString.check(
      Schema.makeFilter((value) => Buffer.byteLength(value) <= 262144),
    ),
  }),
])
export type NativeControl = typeof NativeControl.Type
export type NativeControlReceipt = {
  readonly sessionId: string
  readonly nonce: string
  readonly state: string
  readonly revision: number | null
}
