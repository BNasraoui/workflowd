import { Data, Effect, Schema } from "effect"
import {
  MAX_REMOTE_MESSAGE_BYTES,
  RemoteCommand,
  RemoteFence,
  RemoteHostMessage,
  RemoteResult,
  type RemoteCommand as RemoteCommandValue,
  type RemoteFence as RemoteFenceValue,
  type RemoteResult as RemoteResultValue,
} from "./contract"

export class RemoteContractError extends Data.TaggedError("RemoteContractError")<{
  readonly reason: "malformed" | "oversized"
}> {}

const encode = <A>(schema: Schema.Schema<A>, value: unknown) =>
  Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new RemoteContractError({ reason: "malformed" })),
    Effect.flatMap((decoded) => {
      const bytes = new TextEncoder().encode(JSON.stringify(decoded))
      return bytes.byteLength <= MAX_REMOTE_MESSAGE_BYTES
        ? Effect.succeed(bytes)
        : Effect.fail(new RemoteContractError({ reason: "oversized" }))
    }),
  )

const decode = <A>(schema: Schema.Schema<A>, bytes: Uint8Array) => {
  if (bytes.byteLength > MAX_REMOTE_MESSAGE_BYTES) {
    return Effect.fail(new RemoteContractError({ reason: "oversized" }))
  }
  return Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: () => new RemoteContractError({ reason: "malformed" }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new RemoteContractError({ reason: "malformed" })),
      ),
    ),
  )
}

export const encodeRemoteCommand = (value: RemoteCommandValue) => encode(RemoteCommand, value)
export const encodeRemoteFence = (value: RemoteFenceValue) => encode(RemoteFence, value)
export const encodeRemoteResult = (value: RemoteResultValue) => encode(RemoteResult, value)
export const decodeRemoteCommand = (bytes: Uint8Array) => decode(RemoteCommand, bytes)
export const decodeRemoteHostMessage = (bytes: Uint8Array) => decode(RemoteHostMessage, bytes)
export const decodeRemoteResult = (bytes: Uint8Array) => decode(RemoteResult, bytes)
