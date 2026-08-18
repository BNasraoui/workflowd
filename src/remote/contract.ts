import { Schema } from "effect"

export const MAX_REMOTE_MESSAGE_BYTES = 16_384

const Identifier = Schema.NonEmptyString.pipe(Schema.maxLength(256))
export const RemoteHostId = Schema.NonEmptyString.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
)
const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
)

export const RemoteProbeJobV1 = Schema.Struct({
  kind: Schema.Literal("remote_probe"),
  hostId: RemoteHostId,
})
export type RemoteProbeJobV1 = typeof RemoteProbeJobV1.Type

export const RemoteCommand = Schema.Struct({
  version: Schema.Literal(1),
  commandId: Identifier,
  jobId: Identifier,
  attempt: Schema.Int.pipe(Schema.positive()),
  generation: Schema.Int.pipe(Schema.positive()),
  hostId: RemoteHostId,
  kind: Schema.Literal("probe"),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
})
export type RemoteCommand = typeof RemoteCommand.Type

export const RemoteFence = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("fence"),
  jobId: Identifier,
  generation: Schema.Int.pipe(Schema.positive()),
  hostId: RemoteHostId,
  disposition: Schema.Literal("current", "cancelled"),
  issuedAt: Timestamp,
})
export type RemoteFence = typeof RemoteFence.Type
export const RemoteHostMessage = Schema.Union(RemoteCommand, RemoteFence)
export type RemoteHostMessage = typeof RemoteHostMessage.Type

export const RemoteResult = Schema.Struct({
  version: Schema.Literal(1),
  resultId: Identifier,
  commandId: Identifier,
  jobId: Identifier,
  attempt: Schema.Int.pipe(Schema.positive()),
  generation: Schema.Int.pipe(Schema.positive()),
  hostId: RemoteHostId,
  kind: Schema.Literal("probe"),
  status: Schema.Literal("succeeded"),
  observedAt: Timestamp,
})
export type RemoteResult = typeof RemoteResult.Type
