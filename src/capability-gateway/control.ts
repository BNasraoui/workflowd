import { chmod, chown, lstat, mkdir, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { dirname } from "node:path"
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
import { claimSocketPath, peerCredentials } from "../peer-socket"
import { CapabilityRefused } from "./store"

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
}

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
 * The directory of the socket is the gateway's own: owned by its uid, with the daemon's group,
 * mode 0710, so only that group reaches the socket. The gateway makes it when it is missing and
 * refuses to start when it is anything else.
 */
const claimDirectory = async (directory: string, uid: number, gid: number) => {
  const existing = await lstat(directory).catch(() => null)
  if (existing === null) {
    await mkdir(directory, { mode: 0o700 })
    await chown(directory, uid, gid)
    await chmod(directory, 0o710)
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== uid || info.gid !== gid || (info.mode & 0o7777) !== 0o710)
    throw new Error("control socket directory must be the gateway's, mode 0710, the daemon's group")
}

/**
 * Serves the control socket. Each caller's uid comes from the kernel (SO_PEERCRED on the
 * accepted socket); a caller whose uid is not the daemon's gets `caller` and nothing else.
 */
export const serveControl = (options: {
  readonly socket: string
  readonly daemon: { readonly uid: number; readonly gid: number }
  readonly target: ControlTarget
}) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      if (process.platform !== "linux") throw new Error("the control socket needs SO_PEERCRED")
      const uid = process.getuid!()
      await claimDirectory(dirname(options.socket), uid, options.daemon.gid)
      const release = await claimSocketPath(options.socket)
      const sockets = new Set<Socket>()
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
        socket.on("error", () => socket.destroy())
        socket.setTimeout(10000, () => socket.destroy())
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
          if (peerCredentials(socket)?.uid !== options.daemon.uid)
            return reply({ ok: false, error: "caller" })
          handled = true
          void Effect.runPromise(answer(options.target, buffer.subarray(4).toString("utf8"))).then(
            (value) => socket.end(controlFrame(value)),
            () => socket.end(controlFrame({ ok: false, error: "unavailable" })),
          )
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(options.socket, resolve)
        })
        await chown(options.socket, uid, options.daemon.gid)
        await chmod(options.socket, 0o660)
      } catch (error) {
        server.close()
        await release()
        throw error
      }
      return { server, sockets, release }
    }),
    ({ server, sockets, release }) => {
      for (const socket of sockets) socket.destroy()
      return Effect.promise(() =>
        new Promise<void>((resolve) => server.close(() => resolve()))
          .then(() => rm(options.socket, { force: true }))
          .then(release)
          .catch(() => undefined),
      )
    },
  )
