import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, Redacted, Schema } from "effect"
import { RemoteHostId, MAX_REMOTE_MESSAGE_BYTES } from "../remote/contract"
import { canonicalJson } from "../kernel/session-store-support"
import type { JsonValue } from "../json"
import { DirectoryError, DirectorySnapshot, ExternalRegistration } from "./contract"

const sequence = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
)
const signature = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))
const timestamp = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
)
export const DirectoryObserve = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("directory_observe"),
  hostId: RemoteHostId,
  coordinatorHostId: RemoteHostId,
  generation: sequence,
  nonce: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f-]{36}$/))),
  issuedAt: timestamp,
  expiresAt: timestamp,
  signature,
})
export type DirectoryObserve = typeof DirectoryObserve.Type
export const DirectoryPage = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("directory_page"),
  hostId: RemoteHostId,
  coordinatorHostId: RemoteHostId,
  generation: sequence,
  nonce: DirectoryObserve.fields.nonce,
  page: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 127 }))),
  total: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 128 }))),
  content: Schema.String.pipe(Schema.check(Schema.isMaxLength(8192))),
  signature,
})
export type DirectoryPage = typeof DirectoryPage.Type
export const DirectoryAdvertisement = Schema.Struct({
  snapshot: DirectorySnapshot,
  registrations: Schema.Array(ExternalRegistration),
})
export type DirectoryAdvertisement = typeof DirectoryAdvertisement.Type

export const directoryMac = (credential: Redacted.Redacted<string>, document: JsonValue) =>
  createHmac("sha256", Redacted.value(credential)).update(canonicalJson(document)).digest("hex")
export const authenticDirectoryMessage = (
  credential: Redacted.Redacted<string>,
  message: DirectoryObserve | DirectoryPage,
) => {
  const { signature, ...document } = message
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(directoryMac(credential, document), "hex"),
  )
}
export const directoryBytes = (value: DirectoryObserve | DirectoryPage) =>
  new TextEncoder().encode(JSON.stringify(value))
export const decodeDirectoryMessage = <A>(schema: Schema.Codec<A>, bytes: Uint8Array) =>
  bytes.byteLength > MAX_REMOTE_MESSAGE_BYTES
    ? Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
    : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes), {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new DirectoryError({ reason: "invalid_observation" })))
