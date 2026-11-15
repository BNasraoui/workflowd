import { chmod, chown, lstat, mkdir, rm } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { dirname } from "node:path"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { Cause, Effect, Exit, Schema } from "effect"
import { CapabilityGrant, CapabilityRefused } from "./store"

/**
 * The control socket: workflowd's calls to its gateway. Each connection carries one request and
 * one answer, each a frame of a 4-byte big-endian length and that many bytes of JSON. A request is
 * `{ verb, body }`; an answer is `{ ok: true, value }` or `{ ok: false, error }`.
 */
export const maxControlFrame = 1 << 20

/** A failure of the gateway's store or a refusal; a refusal is a CapabilityRefused. */
export interface ControlFailure {
  readonly _tag: string
}

/** What the gateway does for each verb; the gateway service implements it. */
export interface ControlTarget {
  readonly authorize: (grant: CapabilityGrant) => Effect.Effect<void, ControlFailure>
  readonly revoke: (runId: string) => Effect.Effect<void, ControlFailure>
  readonly reconcile: (
    live: ReadonlyArray<CapabilityGrant>,
  ) => Effect.Effect<ReadonlyArray<string>, ControlFailure>
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

export interface ControlVerbEntry<A, I, B, O> {
  readonly request: Schema.Codec<A, I>
  readonly response: Schema.Codec<B, O>
  readonly handle: (target: ControlTarget) => (body: A) => Effect.Effect<B, ControlFailure>
}

/** An answer's value as it goes on the socket. */
type Json =
  null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** One verb: its request, its answer, and what the gateway does; `serve` runs all three. */
const verb = <A, I, B, O extends Json>(entry: ControlVerbEntry<A, I, B, O>) => ({
  ...entry,
  serve: (
    target: ControlTarget,
    body: unknown,
  ): Effect.Effect<Json, ControlFailure | ControlBodyRefused | Schema.SchemaError> =>
    Schema.decodeUnknownEffect(entry.request)(body).pipe(
      Effect.mapError(() => new ControlBodyRefused()),
      Effect.flatMap(entry.handle(target)),
      Effect.flatMap((value) => Schema.encodeEffect(entry.response)(value)),
    ),
})

/** The verbs of the control socket. A new verb is one entry here. */
export const controlVerbs = {
  authorize: verb({
    request: Schema.Struct({ grant: CapabilityGrant }),
    response: Schema.Null,
    handle: (target) => (body) => Effect.as(target.authorize(body.grant), null),
  }),
  revoke: verb({
    request: Schema.Struct({ runId: Schema.String }),
    response: Schema.Null,
    handle: (target) => (body) => Effect.as(target.revoke(body.runId), null),
  }),
  reconcile: verb({
    request: Schema.Struct({ live: Schema.Array(CapabilityGrant) }),
    response: Schema.Struct({ revoked: Schema.Array(Schema.String) }),
    handle: (target) => (body) =>
      Effect.map(target.reconcile(body.live), (revoked) => ({ revoked })),
  }),
  sessionBound: verb({
    request: Schema.Struct({
      runId: Schema.String,
      actionsRunId: Schema.Int,
      actionsAttempt: Schema.Int,
    }),
    response: Schema.Boolean,
    handle: (target) => (body) =>
      target.sessionBound(body.runId, body.actionsRunId, body.actionsAttempt),
  }),
}
export type ControlVerb = keyof typeof controlVerbs
const isControlVerb = (name: string): name is ControlVerb => Object.hasOwn(controlVerbs, name)
/** Why the gateway refused a request; `unavailable` is a failure the caller may retry. */
export type ControlError = "length" | "body" | "verb" | "caller" | "refused" | "unavailable"

export const controlFrame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

const ControlRequest = Schema.fromJsonString(
  Schema.Struct({ verb: Schema.String, body: Schema.Unknown }),
)

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
const claimDirectory = async (directory: string, gid: number) => {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("control socket needs a uid")
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
      await claimDirectory(dirname(options.socket), options.daemon.gid)
      const stale = await lstat(options.socket).catch(() => null)
      if (stale !== null && !stale.isSocket()) throw new Error("control socket path is taken")
      if (stale !== null) {
        const served = await new Promise<boolean>((resolve) => {
          const probe = createConnection(options.socket)
          probe.on("connect", () => {
            probe.destroy()
            resolve(true)
          })
          probe.on("error", () => resolve(false))
        })
        if (served) throw new Error("another gateway serves the control socket")
        await rm(options.socket)
      }
      const libc = dlopen("libc.so.6", {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      })
      const peerUid = (socket: Socket) => {
        // node:net on Bun exposes the accepted native descriptor through _handle.
        const handle: unknown = Reflect.get(socket, "_handle")
        const fd: unknown =
          typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined
        if (typeof fd !== "number") return undefined
        const credentials = new Int32Array(3)
        const length = new Uint32Array([12])
        return libc.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length)) === 0 &&
          length[0] === 12
          ? credentials[1]
          : undefined
      }
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
          if (peerUid(socket) !== options.daemon.uid) return reply({ ok: false, error: "caller" })
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
        await chown(options.socket, process.getuid!(), options.daemon.gid)
        await chmod(options.socket, 0o660)
      } catch (error) {
        server.close()
        libc.close()
        throw error
      }
      return { server, sockets, libc }
    }),
    ({ server, sockets, libc }) => {
      for (const socket of sockets) socket.destroy()
      return Effect.promise(() =>
        new Promise<void>((resolve) => server.close(() => resolve()))
          .then(() => {
            libc.close()
            return rm(options.socket, { force: true })
          })
          .catch(() => undefined),
      )
    },
  )
