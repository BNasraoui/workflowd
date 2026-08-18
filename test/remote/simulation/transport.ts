import { Effect } from "effect"
import {
  encodeRemoteCommand,
  encodeRemoteFence,
  encodeRemoteResult,
} from "../../../src/remote/codec"
import {
  RemoteTransport,
  RemoteTransportError,
  type RemoteDelivery,
  type RemoteTransportPort,
} from "../../../src/remote/transport"

type Channel = "host" | "result"
type Endpoint = "runner-a" | "runner-b" | "coordinator"
type Message = {
  readonly sequence: number
  readonly channel: Channel
  readonly hostId?: string
  readonly data: Uint8Array
  acknowledged: boolean
  delayed: boolean
}

export type DeterministicTransport = {
  readonly port: RemoteTransportPort
  readonly pending: (channel: Channel) => number
  readonly delay: (channel: Channel) => void
  readonly release: (channel: Channel) => void
  readonly duplicate: (channel: Channel) => void
  readonly reorder: (channel: Channel) => void
  readonly disconnect: (endpoint: Endpoint) => void
  readonly reconnect: (endpoint: Endpoint) => void
  readonly injectHost: (host: Exclude<Endpoint, "coordinator">, data: Uint8Array) => void
}

export const makeDeterministicTransport = (
  options: { readonly singleMessageBatches?: boolean } = {},
): DeterministicTransport => {
  const messages: Array<Message> = []
  const offline = new Set<string>()
  let nextSequence = 1

  const requireOnline = (endpoint: string) =>
    offline.has(endpoint)
      ? Effect.fail(
          new RemoteTransportError({ operation: "connect", cause: `${endpoint} disconnected` }),
        )
      : Effect.void

  const encodingFailure = (cause: unknown) =>
    new RemoteTransportError({ operation: "publish", cause })

  const publish = (channel: Channel, data: Uint8Array, hostId?: string) =>
    Effect.sync(() => {
      messages.push({
        sequence: nextSequence++,
        channel,
        ...(hostId === undefined ? {} : { hostId }),
        data,
        acknowledged: false,
        delayed: false,
      })
    })

  const deliveries = (channel: Channel, hostId?: string, maximum = 100) => {
    const available = messages.filter(
      (message) =>
        message.channel === channel &&
        !message.acknowledged &&
        !message.delayed &&
        (hostId === undefined || message.hostId === hostId),
    )
    return available.slice(0, maximum).map((message, index): RemoteDelivery => ({
      deliveryId: `sim:${message.sequence}`,
      data: message.data,
      pending: available.length - index - 1,
      acknowledge: Effect.sync(() => {
        message.acknowledged = true
        return true
      }),
    }))
  }

  const port = RemoteTransport.of({
    ensureInfrastructure: () => Effect.void,
    publishCommand: (command) =>
      requireOnline("coordinator").pipe(
        Effect.andThen(encodeRemoteCommand(command).pipe(Effect.mapError(encodingFailure))),
        Effect.flatMap((data) => publish("host", data, command.hostId)),
      ),
    publishFence: (fence) =>
      requireOnline("coordinator").pipe(
        Effect.andThen(encodeRemoteFence(fence).pipe(Effect.mapError(encodingFailure))),
        Effect.flatMap((data) => publish("host", data, fence.hostId)),
      ),
    publishResult: (result) =>
      requireOnline(result.hostId).pipe(
        Effect.andThen(encodeRemoteResult(result).pipe(Effect.mapError(encodingFailure))),
        Effect.flatMap((data) => publish("result", data)),
      ),
    publishRaw: (subject, data) =>
      requireOnline("coordinator").pipe(
        Effect.andThen(publish(subject === "workflowd.v1.results" ? "result" : "host", data)),
      ),
    takeHost: (hostId) =>
      requireOnline(hostId).pipe(
        Effect.andThen(Effect.sync(() => deliveries("host", hostId, 1))),
        Effect.catchTag("RemoteTransportError", () => Effect.succeed([])),
      ),
    takeHostBatch: (hostId) =>
      requireOnline(hostId).pipe(
        Effect.andThen(
          Effect.sync(() =>
            deliveries("host", hostId, options.singleMessageBatches === true ? 1 : 100),
          ),
        ),
        Effect.catchTag("RemoteTransportError", () => Effect.succeed([])),
      ),
    takeResults: () =>
      requireOnline("coordinator").pipe(
        Effect.andThen(Effect.sync(() => deliveries("result", undefined, 1))),
        Effect.catchTag("RemoteTransportError", () => Effect.succeed([])),
      ),
    consumeHost: () => Effect.never,
  })

  return {
    port,
    pending: (channel) =>
      messages.filter((message) => message.channel === channel && !message.acknowledged).length,
    delay: (channel) => {
      for (const message of messages) {
        if (message.channel === channel && !message.acknowledged) message.delayed = true
      }
    },
    release: (channel) => {
      for (const message of messages) if (message.channel === channel) message.delayed = false
    },
    duplicate: (channel) => {
      const source = messages.findLast((message) => message.channel === channel)
      if (source === undefined) return
      messages.push({
        ...source,
        sequence: nextSequence++,
        data: source.data.slice(),
        acknowledged: false,
      })
    },
    reorder: (channel) => {
      const indexes = messages.flatMap((message, index) =>
        message.channel === channel && !message.acknowledged && !message.delayed ? [index] : [],
      )
      if (indexes.length < 2) return
      const [first, second] = indexes
      ;[messages[first!], messages[second!]] = [messages[second!]!, messages[first!]!]
    },
    disconnect: (endpoint) => {
      offline.add(endpoint)
    },
    reconnect: (endpoint) => {
      offline.delete(endpoint)
    },
    injectHost: (hostId, data) => {
      messages.push({
        sequence: nextSequence++,
        channel: "host",
        hostId,
        data: data.slice(),
        acknowledged: false,
        delayed: false,
      })
    },
  }
}
