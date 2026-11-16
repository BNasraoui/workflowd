import { createServer, type Socket } from "node:net"
import { Cause, Effect, Exit, Schema } from "effect"
import {
  type CapabilityGrant,
  ControlRequest,
  controlFrame,
  controlProtocol,
  type ControlError,
  type ControlVerb,
  type ControlVerbSchemas,
  maxControlFrame,
} from "../capability-control/protocol"
import { peerCredentials, serveSocket } from "../peer-socket"
import { CapabilityRefused } from "./store"

/** The daemon's connections that the gateway holds open at once; another one gets `unavailable`. */
export const maxControlConnections = 16
/** A connection, refused or not, ends this long after the gateway accepted it, whatever it sent. */
export const controlConnectionMs = 10000

/** A failure of the gateway's store or a refusal; a refusal is a CapabilityRefused. */
export interface ControlFailure {
  readonly _tag: string
}

/** What the gateway does for each verb; the gateway service implements it. */
export interface ControlTarget {
  readonly authorize: (grant: CapabilityGrant) => Effect.Effect<void, ControlFailure>
  readonly revoke: (runId: string) => Effect.Effect<void, ControlFailure>
  readonly reconcile: (live: ReadonlyArray<CapabilityGrant>) => Effect.Effect<void, ControlFailure>
  readonly sessionBound: (
    runId: string,
    actionsRunId: number,
    actionsAttempt: number,
  ) => Effect.Effect<boolean, ControlFailure>
  readonly usage: (runId: string) => Effect.Effect<RunUsage, ControlFailure>
}
/** What a run spent of its budget, as the `usage` verb answers it. */
type RunUsage = typeof controlProtocol.usage.response.Type

/** The request's body does not decode as its verb's request. */
class ControlBodyRefused extends Schema.TaggedError<ControlBodyRefused>()(
  "ControlBodyRefused",
  {},
) {}

/** An answer's value as it goes on the socket. */
type Json =
  null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** One verb: its protocol entry and what the gateway does; `serve` decodes, runs and encodes. */
const verb = <A, I, B, O extends Json>(
  schemas: ControlVerbSchemas<A, I, B, O>,
  handle: (target: ControlTarget) => (body: A) => Effect.Effect<B, ControlFailure>,
) => ({
  serve: (
    target: ControlTarget,
    body: unknown,
  ): Effect.Effect<Json, ControlFailure | ControlBodyRefused | Schema.SchemaError> =>
    Schema.decodeUnknownEffect(schemas.request)(body).pipe(
      Effect.mapError(() => new ControlBodyRefused()),
      Effect.flatMap(handle(target)),
      Effect.flatMap((value) => Schema.encodeEffect(schemas.response)(value)),
    ),
})

/** The gateway's handler of each verb of the protocol. */
const controlVerbs: Record<ControlVerb, ReturnType<typeof verb>> = {
  authorize: verb(
    controlProtocol.authorize,
    (target) => (body) => Effect.as(target.authorize(body.grant), null),
  ),
  revoke: verb(
    controlProtocol.revoke,
    (target) => (body) => Effect.as(target.revoke(body.runId), null),
  ),
  reconcile: verb(
    controlProtocol.reconcile,
    (target) => (body) => Effect.as(target.reconcile(body.live), null),
  ),
  sessionBound: verb(
    controlProtocol.sessionBound,
    (target) => (body) => target.sessionBound(body.runId, body.actionsRunId, body.actionsAttempt),
  ),
  usage: verb(controlProtocol.usage, (target) => (body) => target.usage(body.runId)),
}
const isControlVerb = (name: string): name is ControlVerb => Object.hasOwn(controlVerbs, name)

/** One request's answer, for a caller that passed the uid check. */
const answer = (target: ControlTarget, text: string) =>
  Effect.gen(function* () {
    const refused = (error: ControlError) => ({ ok: false, error })
    const request = yield* Effect.result(Schema.decodeUnknownEffect(ControlRequest)(text))
    if (request._tag === "Failure") return refused("body")
    const name = request.success.verb
    if (!isControlVerb(name)) return refused("verb")
    const exit = yield* Effect.exit(controlVerbs[name].serve(target, request.success.body))
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
    const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
    if (failure instanceof ControlBodyRefused) return refused("body")
    return refused(failure instanceof CapabilityRefused ? "refused" : "unavailable")
  })

/**
 * Serves the control socket. The gateway reads each caller's uid from the kernel (SO_PEERCRED)
 * as it accepts the connection, before it reads a byte: a caller whose uid is not the daemon's
 * gets `caller`, and the connection ends. It holds at most `maxControlConnections` of the
 * daemon's connections, and ends each `controlConnectionMs` after it accepted it.
 */
export const serveControl = (options: {
  readonly socket: string
  readonly daemon: { readonly uid: number; readonly gid: number }
  readonly target: ControlTarget
}) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const sockets = new Set<Socket>()
      const refused = new Set<Socket>()
      const server = createServer((socket) => {
        const deadline = setTimeout(() => socket.destroy(), controlConnectionMs)
        socket.on("close", () => {
          clearTimeout(deadline)
          sockets.delete(socket)
          refused.delete(socket)
        })
        socket.on("error", () => socket.destroy())
        // A refused caller gets its answer, and the end of the gateway's side, as the gateway
        // accepts the connection. The gateway then reads and drops the caller's bytes, up to one
        // frame, until the caller ends its side: the caller's request never meets a closed socket.
        // At most `maxControlConnections` refused connections are open at once.
        const refuse = (error: ControlError) => {
          if (refused.size >= maxControlConnections) return socket.destroy()
          refused.add(socket)
          let dropped = 0
          socket.on("data", (chunk) => {
            dropped += chunk.length
            if (dropped > maxControlFrame + 4) socket.destroy()
          })
          socket.end(controlFrame({ ok: false, error }))
        }
        if (peerCredentials(socket)?.uid !== options.daemon.uid) return refuse("caller")
        if (sockets.size >= maxControlConnections) return refuse("unavailable")
        sockets.add(socket)
        let buffer = Buffer.alloc(0)
        let handled = false
        const reply = (value: unknown) => {
          handled = true
          socket.end(controlFrame(value))
        }
        socket.on("data", (chunk) => {
          if (handled) return
          buffer = Buffer.concat([buffer, Buffer.from(chunk)])
          if (buffer.length < 4) return
          const length = buffer.readUInt32BE(0)
          if (length > maxControlFrame) return reply({ ok: false, error: "length" })
          if (buffer.length < 4 + length) return
          if (buffer.length > 4 + length) return reply({ ok: false, error: "length" })
          handled = true
          void Effect.runPromise(answer(options.target, buffer.subarray(4).toString("utf8"))).then(
            (value) => socket.end(controlFrame(value)),
            () => socket.end(controlFrame({ ok: false, error: "unavailable" })),
          )
        })
      })
      // The directory is the gateway's, mode 0710 with the daemon's group: only that group reaches
      // the socket.
      const close = await serveSocket(server, options.socket, options.daemon.gid, 0o710, {
        socket: "control socket",
        group: "the daemon's group",
      })
      return { sockets, refused, close }
    }),
    ({ sockets, refused, close }) => {
      for (const socket of [...sockets, ...refused]) socket.destroy()
      return Effect.tryPromise(close).pipe(Effect.orDie)
    },
  )
