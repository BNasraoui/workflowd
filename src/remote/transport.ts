import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
} from "@nats-io/jetstream"
import type { JsMsg } from "@nats-io/jetstream"
import type { NatsConnection } from "@nats-io/nats-core"
import { connect } from "@nats-io/transport-node"
import { Context, Data, Effect, Exit, Layer, Runtime } from "effect"
import {
  MAX_REMOTE_MESSAGE_BYTES,
  type RemoteCommand,
  type RemoteFence,
  type RemoteResult,
} from "./contract"
import { encodeRemoteCommand, encodeRemoteFence, encodeRemoteResult } from "./codec"

const COMMAND_STREAM = "WORKFLOWD_COMMANDS_V1"
const RESULT_STREAM = "WORKFLOWD_RESULTS_V1"
const RESULT_SUBJECT = "workflowd.v1.results"
const STREAM_MAX_AGE_NANOS = 24 * 60 * 60 * 1_000_000_000
const STREAM_MAX_BYTES = 64 * 1024 * 1024
const CONSUMER_ACK_WAIT_NANOS = 2_000_000_000
const CONSUMER_MAX_DELIVER = 20
const CONSUMER_MAX_ACK_PENDING = 1_000
const commandSubject = (hostId: string) => `workflowd.v1.commands.${hostId}`

export class RemoteTransportError extends Data.TaggedError("RemoteTransportError")<{
  readonly operation: "connect" | "close" | "ensure" | "publish" | "consume" | "ack"
  readonly cause: unknown
}> {}

export type RemoteDelivery = {
  readonly deliveryId: string
  readonly data: Uint8Array
  readonly pending: number
  readonly acknowledge: Effect.Effect<boolean, RemoteTransportError>
}

export type RemoteTransportPort = {
  readonly ensureInfrastructure: () => Effect.Effect<void, RemoteTransportError>
  readonly publishCommand: (command: RemoteCommand) => Effect.Effect<void, RemoteTransportError>
  readonly publishFence: (fence: RemoteFence) => Effect.Effect<void, RemoteTransportError>
  readonly publishResult: (result: RemoteResult) => Effect.Effect<void, RemoteTransportError>
  readonly publishRaw: (
    subject: string,
    data: Uint8Array,
  ) => Effect.Effect<void, RemoteTransportError>
  readonly takeHost: (
    hostId: string,
    expiresMs?: number,
  ) => Effect.Effect<ReadonlyArray<RemoteDelivery>, RemoteTransportError>
  readonly takeHostBatch: (
    hostId: string,
    expiresMs?: number,
  ) => Effect.Effect<ReadonlyArray<RemoteDelivery>, RemoteTransportError>
  readonly takeResults: (
    expiresMs?: number,
  ) => Effect.Effect<ReadonlyArray<RemoteDelivery>, RemoteTransportError>
  readonly consumeHost: <E>(
    hostId: string,
    handle: (delivery: RemoteDelivery) => Effect.Effect<void, E>,
  ) => Effect.Effect<void, E | RemoteTransportError>
}

export const RemoteTransport = Context.GenericTag<RemoteTransportPort>(
  "workflowd/remote/RemoteTransport",
)

export type RemoteTransportConfig = {
  readonly servers: ReadonlyArray<string>
  readonly token?: string
}

const transportError = (operation: RemoteTransportError["operation"]) => (cause: unknown) =>
  new RemoteTransportError({ operation, cause })

const tryPromise = <A>(operation: RemoteTransportError["operation"], try_: () => Promise<A>) =>
  Effect.tryPromise({ try: try_, catch: transportError(operation) })

const transientPublishFailure = (error: RemoteTransportError) => {
  const message = String(error.cause).toLowerCase()
  return message.includes("timeout") || message.includes("disconnect") || message.includes("closed")
}

const toDelivery = (stream: string, message: JsMsg): RemoteDelivery => ({
  deliveryId: `${stream}:${message.info.streamSequence}`,
  data: message.data,
  pending: message.info.pending,
  acknowledge: tryPromise("ack", () => message.ackAck({ timeout: 5_000 })),
})

const consumeMessages = async <E>(
  messages: AsyncIterable<JsMsg>,
  runtime: Runtime.Runtime<never>,
  handle: (delivery: RemoteDelivery) => Effect.Effect<void, E>,
  resume: (effect: Effect.Effect<void, E | RemoteTransportError>) => void,
) => {
  try {
    for await (const message of messages) {
      const exit = await Runtime.runPromiseExit(runtime)(
        handle(toDelivery(COMMAND_STREAM, message)),
      )
      if (Exit.isFailure(exit)) {
        resume(Effect.failCause(exit.cause))
        return
      }
    }
    resume(Effect.void)
  } catch (cause) {
    resume(Effect.fail(transportError("consume")(cause)))
  }
}

const closeMessages = (messages: { readonly close: () => Promise<unknown> }) =>
  tryPromise("consume", messages.close.bind(messages)).pipe(Effect.ignore)

const ensureConsumer = (
  connection: NatsConnection,
  stream: string,
  durable: string,
  filterSubject: string,
) =>
  tryPromise("consume", async () => {
    const manager = await jetstreamManager(connection)
    let info
    try {
      info = await manager.consumers.info(stream, durable)
    } catch {
      await manager.consumers.add(stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subject: filterSubject,
        max_deliver: CONSUMER_MAX_DELIVER,
        ack_wait: CONSUMER_ACK_WAIT_NANOS,
        max_ack_pending: CONSUMER_MAX_ACK_PENDING,
      })
      info = await manager.consumers.info(stream, durable)
    }
    if (
      info.config.ack_policy !== AckPolicy.Explicit ||
      info.config.deliver_policy !== DeliverPolicy.All ||
      info.config.filter_subject !== filterSubject ||
      info.config.durable_name !== durable ||
      info.config.max_deliver !== CONSUMER_MAX_DELIVER ||
      info.config.ack_wait !== CONSUMER_ACK_WAIT_NANOS ||
      info.config.max_ack_pending !== CONSUMER_MAX_ACK_PENDING
    ) {
      throw new Error(`incompatible JetStream consumer ${durable}`)
    }
    return jetstream(connection).consumers.get(stream, durable)
  })

const make = (config: RemoteTransportConfig) =>
  Effect.gen(function* () {
    const state = yield* Effect.acquireRelease(
      Effect.sync(() => ({
        connection: undefined as NatsConnection | undefined,
        connecting: undefined as Promise<NatsConnection> | undefined,
        closed: false,
      })),
      (state) =>
        Effect.sync(() => {
          state.closed = true
        }).pipe(
          Effect.andThen(
            state.connection === undefined
              ? Effect.void
              : tryPromise("close", () => state.connection!.drain()).pipe(Effect.ignore),
          ),
        ),
    )

    const getConnection = () =>
      tryPromise("connect", async () => {
        if (state.connection !== undefined && !state.connection.isClosed()) {
          return state.connection
        }
        if (state.connecting !== undefined) return state.connecting
        const connecting = connect({
          servers: [...config.servers],
          ...(config.token === undefined ? {} : { token: config.token }),
          maxReconnectAttempts: -1,
          reconnectTimeWait: 100,
          ignoreClusterUpdates: true,
          waitOnFirstConnect: false,
        })
        state.connecting = connecting
        try {
          const connection = await connecting
          if (state.closed) {
            await connection.drain()
            throw new Error("remote transport scope is closed")
          }
          state.connection = connection
          return connection
        } finally {
          if (state.connecting === connecting) state.connecting = undefined
        }
      })

    const ensureInfrastructure = () =>
      getConnection().pipe(
        Effect.flatMap((connection) =>
          tryPromise("ensure", async () => {
            const manager = await jetstreamManager(connection)
            for (const stream of [
              { name: COMMAND_STREAM, subjects: ["workflowd.v1.commands.*"] },
              { name: RESULT_STREAM, subjects: [RESULT_SUBJECT] },
            ]) {
              let info
              try {
                info = await manager.streams.info(stream.name)
              } catch {
                await manager.streams.add({
                  ...stream,
                  retention: RetentionPolicy.Limits,
                  storage: StorageType.File,
                  discard: DiscardPolicy.Old,
                  max_age: STREAM_MAX_AGE_NANOS,
                  max_bytes: STREAM_MAX_BYTES,
                  max_msg_size: MAX_REMOTE_MESSAGE_BYTES,
                })
                info = await manager.streams.info(stream.name)
              }
              if (
                info.config.storage !== StorageType.File ||
                info.config.retention !== RetentionPolicy.Limits ||
                info.config.discard !== DiscardPolicy.Old ||
                info.config.max_msg_size !== MAX_REMOTE_MESSAGE_BYTES ||
                info.config.max_age !== STREAM_MAX_AGE_NANOS ||
                info.config.max_bytes !== STREAM_MAX_BYTES ||
                info.config.subjects.length !== stream.subjects.length ||
                !stream.subjects.every((subject) => info.config.subjects.includes(subject))
              ) {
                throw new Error(`incompatible JetStream stream ${stream.name}`)
              }
            }
          }),
        ),
      )

    const publishRaw: RemoteTransportPort["publishRaw"] = (subject, data) =>
      getConnection().pipe(
        Effect.flatMap((connection) =>
          tryPromise("publish", () => jetstream(connection).publish(subject, data)),
        ),
        Effect.retry({ times: 5, while: transientPublishFailure }),
        Effect.asVoid,
      )

    const collect = (
      stream: string,
      durable: string,
      subject: string,
      expiresMs: number,
      maxMessages: number,
    ) =>
      Effect.gen(function* () {
        const connection = yield* getConnection()
        const consumer = yield* ensureConsumer(connection, stream, durable, subject)
        const messages = yield* tryPromise("consume", () =>
          consumer.fetch({ max_messages: maxMessages, expires: expiresMs }),
        )
        const deliveries: Array<RemoteDelivery> = []
        yield* Effect.tryPromise({
          try: async () => {
            for await (const message of messages) {
              deliveries.push(toDelivery(stream, message))
            }
          },
          catch: transportError("consume"),
        })
        return deliveries
      })

    const consumeHost = <E>(
      hostId: string,
      handle: (delivery: RemoteDelivery) => Effect.Effect<void, E>,
    ): Effect.Effect<void, E | RemoteTransportError> =>
      Effect.gen(function* () {
        const connection = yield* getConnection()
        const consumer = yield* ensureConsumer(
          connection,
          COMMAND_STREAM,
          `runner-${hostId}`,
          commandSubject(hostId),
        )
        const messages = yield* tryPromise("consume", () => consumer.consume())
        const runtime = yield* Effect.runtime()
        return yield* Effect.async<void, E | RemoteTransportError>((resume) => {
          void consumeMessages(messages, runtime, handle, resume)
          return closeMessages(messages)
        })
      })

    return RemoteTransport.of({
      ensureInfrastructure,
      publishRaw,
      publishCommand: (command) =>
        encodeRemoteCommand(command).pipe(
          Effect.mapError(transportError("publish")),
          Effect.flatMap((data) => publishRaw(commandSubject(command.hostId), data)),
        ),
      publishFence: (fence) =>
        encodeRemoteFence(fence).pipe(
          Effect.mapError(transportError("publish")),
          Effect.flatMap((data) => publishRaw(commandSubject(fence.hostId), data)),
        ),
      publishResult: (result) =>
        encodeRemoteResult(result).pipe(
          Effect.mapError(transportError("publish")),
          Effect.flatMap((data) => publishRaw(RESULT_SUBJECT, data)),
        ),
      takeHost: (hostId, expiresMs = 30_000) =>
        collect(COMMAND_STREAM, `runner-${hostId}`, commandSubject(hostId), expiresMs, 1),
      takeHostBatch: (hostId, expiresMs = 1_000) =>
        collect(COMMAND_STREAM, `runner-${hostId}`, commandSubject(hostId), expiresMs, 100),
      takeResults: (expiresMs = 30_000) =>
        collect(RESULT_STREAM, "workflowd-coordinator-v1", RESULT_SUBJECT, expiresMs, 1),
      consumeHost,
    })
  })

export const RemoteTransportLive = (config: RemoteTransportConfig) =>
  Layer.scoped(RemoteTransport, make(config))
