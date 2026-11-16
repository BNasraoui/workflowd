import { Effect, Option, Schema, Semaphore } from "effect"
import {
  maxEventBatchBytes,
  maxResultBody,
  maxResultBundleBytes,
  maxResultManifestBytes,
  maxRunUploads,
} from "../../deploy/sandbox/capability-limits.mjs"
import { bodyDigest, runSignatureHeader } from "../../deploy/sandbox/renewal.mjs"
import type { RunLaunch } from "../capability-control/protocol"
import { readRequestBody } from "./claude"
import { ownedPromise } from "./owned"
import { CapabilityRefused, type makeCapabilityStore } from "./store"

/**
 * The run routes of a run placed on a runner: its launch, its event batches and its one result.
 * They are outside the run's budget: no call and no token is counted. Each route is reached only
 * after `store.authenticate` took the run token; a run with no launch, an unknown route, a wrong
 * method, a body over its bound, a missing or wrong signature and a refused write each get the
 * same empty 403, and change nothing. Only a fault of the gateway is 503.
 *
 * The launch has no body: the run token alone reads it. A signature there could only sign a
 * constant, which a party that holds the token and saw one request could send again, so it would
 * prove nothing more than the token; the launch changes nothing and tells the run only what the
 * run is given anyway. A route with a body carries the session key's signature over the SHA-256
 * of the exact body, with a prefix of its own (`runMessage` in renewal.mjs).
 */
export const runRoutePrefix = "/capabilities/v1/run/"
const routes = new Map<string, "launch" | "events" | "result">([
  ["/capabilities/v1/run/launch", "launch"],
  ["/capabilities/v1/run/events", "events"],
  ["/capabilities/v1/run/result", "result"],
])

const denied = () => new Response(null, { status: 403 })
const unavailable = () => new Response(null, { status: 503, headers: { "retry-after": "5" } })
const busy = () => new Response(null, { status: 429, headers: { "retry-after": "1" } })
const noStore = { headers: { "cache-control": "no-store" } }

/** An events body: its sequence number and its lines, and no other key. */
const EventsBody = Schema.fromJsonString(
  Schema.Struct({
    sequence: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
    lines: Schema.Array(Schema.String).check(Schema.isMaxLength(4096)),
  }),
)

type Store = Effect.Success<typeof makeCapabilityStore>
/** What a run route reads of the run's grant. */
type RunGrant = {
  readonly modelId: string
  readonly sourceSha: string
  readonly deadline: number
  readonly launch?: RunLaunch
}
type Binding = { readonly runId: string; readonly channel: string }

/** The bytes of a request's body when its declared length is within `limit`, else undefined. */
const boundedBody = (request: Request, limit: number) => {
  const declared = request.headers.get("content-length")
  if (declared === null || !/^[0-9]{1,9}$/.test(declared) || Number(declared) > limit)
    return Effect.succeed(undefined)
  return ownedPromise((signal) =>
    readRequestBody(
      request,
      AbortSignal.any([signal, request.signal, AbortSignal.timeout(120000)]),
      Number(declared),
    ),
  ).pipe(
    Effect.map((bytes) => (bytes.length === Number(declared) ? bytes : undefined)),
    Effect.orElseSucceed(() => undefined),
  )
}

/** True when a result body is framed as the run routes say: a length, result.json, the bundle. */
const framedResult = (body: Uint8Array) => {
  if (body.length < 4) return false
  const manifest = Buffer.from(body.buffer, body.byteOffset, body.byteLength).readUInt32BE(0)
  const bundle = body.length - 4 - manifest
  return (
    manifest > 0 &&
    manifest <= maxResultManifestBytes &&
    bundle > 0 &&
    bundle <= maxResultBundleBytes
  )
}

/**
 * The run routes over `store`. The caller passes a request whose run token `store.authenticate`
 * took, with the token's binding and the run's grant, and the raw path that the runner sent.
 */
export const makeRunRoutes = Effect.gen(function* () {
  const uploads = yield* Semaphore.make(maxRunUploads)
  return (store: Store) =>
    Effect.fn("CapabilityGateway.runRoute")(
      function* (request: Request, target: string, binding: Binding, grant: RunGrant) {
        const route = routes.get(target) ?? null
        const launch = grant.launch
        if (route === null || launch === undefined) return denied()
        if (route === "launch") {
          if (request.method !== "GET") return denied()
          return Response.json(
            {
              prompt: launch.prompt,
              image: launch.image,
              model: grant.modelId,
              sourceSha: grant.sourceSha,
              deadline: grant.deadline,
            },
            noStore,
          )
        }
        if (request.method !== "POST") return denied()
        const signature = request.headers.get(runSignatureHeader)
        if (signature === null) return denied()
        if (route === "events") {
          const body = yield* boundedBody(request, maxEventBatchBytes)
          if (body === undefined) return denied()
          if (!(yield* store.runSigned(binding, route, bodyDigest(body), signature)))
            return denied()
          const decoded = yield* Effect.result(
            Schema.decodeUnknownEffect(EventsBody)(body.toString("utf8"), {
              onExcessProperty: "error",
            }),
          )
          if (decoded._tag === "Failure") return denied()
          const lines = JSON.stringify(decoded.success.lines)
          yield* store.appendEvents(
            binding.runId,
            decoded.success.sequence,
            lines,
            Buffer.byteLength(lines),
          )
          return new Response(null, { status: 204 })
        }
        // The result: the uploads at once are capped before any byte is read.
        const held = yield* Effect.gen(function* () {
          const body = yield* boundedBody(request, maxResultBody)
          if (body === undefined || !framedResult(body)) return denied()
          const digest = bodyDigest(body)
          if (!(yield* store.runSigned(binding, route, digest, signature))) return denied()
          yield* store.holdResult(binding.runId, digest, body)
          return new Response(null, { status: 204 })
        }).pipe(uploads.withPermitsIfAvailable(1))
        return Option.getOrElse(held, busy)
      },
      Effect.catchIf(
        (error) => error instanceof CapabilityRefused,
        () => Effect.succeed(denied()),
      ),
      Effect.catch(() => Effect.succeed(unavailable())),
    )
})
