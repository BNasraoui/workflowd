import { Context, Effect, Option, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomInt } from "node:crypto"
import { mintCapability } from "./noscope"
import { custodyProvider, loginFault } from "./custody"
import { claudeRequest, readRequestBody, type ClaudeUpstream } from "./claude"
import { CapabilityRefused, capabilityDigest, makeCapabilityStore } from "./store"
import { githubJobKeys, verifyJobProof } from "../sandbox/bootstrap"
import { runLifetime } from "../store/run-lifetime"
import { ownedPromise } from "./owned"
import { gitReadRequest, type GitUpstream } from "./git"
import type { ControlTarget } from "./control"
import { renewLeadMaxMs, renewLeadMinMs } from "../../deploy/sandbox/renewal.mjs"
import { capabilityOrigin, RequestRefused } from "./headers"
import { maxJtiLength, maxProofLength } from "../../deploy/sandbox/capability-limits.mjs"
import type { CapabilityGatewayConfig } from "../sandbox/config"

/** The gateway's keys that the service reads; the process alone reads the store, socket and listener. */
type GatewayConfiguration = Omit<
  CapabilityGatewayConfig,
  "storePath" | "controlSocket" | "daemon" | "listen"
>
/** The idle limit of a stream when the config names none. */
const defaultStreamIdleMs = 120000
const SessionProof = Schema.Struct({
  token: Schema.String.check(Schema.isMaxLength(maxProofLength)),
})
const SessionAudience = /^workflowd:([a-f0-9]{64}):([a-f0-9]{64})$/
/**
 * Reads the audience and jti of an unverified proof only to select its challenge and to refuse a
 * used proof early; verification follows.
 */
const proofClaims = (token: string) => {
  try {
    const [header, payload] = token
      .split(".")
      .slice(0, 2)
      .map((part): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8")))
    const field = (value: unknown, name: string): unknown =>
      typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined
    const audience = field(payload, "aud")
    const jti = field(payload, "jti")
    const kid = field(header, "kid")
    const match = typeof audience === "string" ? SessionAudience.exec(audience) : null
    return match?.[1] &&
      match[2] &&
      typeof jti === "string" &&
      jti.length <= maxJtiLength &&
      typeof kid === "string"
      ? { audience: match[0], channel: match[1], nonce: match[2], jti, kid }
      : null
  } catch {
    return null
  }
}
/** The job key set is kept this long; a key id it does not hold fetches again at most once a minute. */
const keySetMs = 600000
const keyRefetchMs = 60000
const holdsKey = (keys: unknown, kid: string) => {
  const list: unknown = typeof keys === "object" && keys !== null ? Reflect.get(keys, "keys") : null
  return Array.isArray(list) && list.some((key: unknown) => Reflect.get(Object(key), "kid") === kid)
}
/**
 * One job key set for every proof. A fetch is shared by the proofs that wait for it, and a failed
 * fetch is not kept, so the next proof tries again. A key id that the set does not hold fetches
 * again only when no such fetch ran in the last minute.
 */
const cachedJobKeys = (keys: typeof githubJobKeys) => {
  let held: { readonly at: number; readonly value: Promise<unknown> } | undefined
  let missedAt = -Infinity
  const refresh = (seen: typeof held) => {
    if (held !== undefined && held !== seen) return held.value
    const entry = { at: Date.now(), value: keys(AbortSignal.timeout(10000)) }
    held = entry
    entry.value.catch(() => {
      if (held === entry) held = undefined
    })
    return entry.value
  }
  return async (kid: string) => {
    const seen = held
    if (!seen || Date.now() - seen.at >= keySetMs) return refresh(seen)
    const value = await seen.value
    if (holdsKey(value, kid) || Date.now() - missedAt < keyRefetchMs) return value
    missedAt = Date.now()
    return refresh(seen)
  }
}
/** At most this many run token mints run at once; a request above it is answered 503. */
const maxMints = 4
class MintsBusy extends Schema.TaggedError<MintsBusy>()("MintsBusy", {}) {}
/** A run token lives at most 15 minutes. */
const tokenLifeMs = 900000
/** Its holder renews it within the renewal lead before it expires, or now when less is left. */
const renewAt = (expiresAt: number) =>
  Math.max(Date.now(), expiresAt - randomInt(renewLeadMinMs, renewLeadMaxMs + 1))
/** The kind of a failure for the log: its tag or its class name, never its text or values. */
const failureKind = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : typeof error
const logFailure = (message: string) => (error: unknown) =>
  Effect.logWarning(message, { kind: failureKind(error) })
const denied = () => new Response(null, { status: 403 })
const unavailable = () => new Response(null, { status: 503, headers: { "retry-after": "5" } })

/** Owns run authority and stream lifetime. No administrative HTTP listener shares this interface. */
export const makeCapabilityGateway = (
  config: GatewayConfiguration,
  upstream: ClaudeUpstream = fetch,
  gitUpstream: GitUpstream = fetch,
  keys: typeof githubJobKeys = githubJobKeys,
) =>
  Effect.gen(function* () {
    const streamIdleMs = config.streamIdleMs ?? defaultStreamIdleMs
    const store = yield* makeCapabilityStore
    const sql = yield* SqlClient.SqlClient
    const authority = runLifetime(sql)
    // Each live stream, by run, with the session and the digest of the token that opened it.
    const active = new Map<
      string,
      Map<AbortController, { readonly session: number; readonly digest: string }>
    >()
    let count = 0
    const abortRun = (runId: string) => {
      for (const controller of active.get(runId)?.keys() ?? []) controller.abort()
    }
    const streams = () =>
      [...active].flatMap(([runId, owned]) =>
        [...owned.values()].map((owner) => ({ runId, ...owner })),
      )
    const abortStale = (
      stale: ReadonlyArray<{
        readonly runId: string
        readonly session: number
        readonly digest: string
      }>,
    ) => {
      for (const { runId, session, digest } of stale)
        for (const [controller, owner] of active.get(runId) ?? [])
          if (owner.session === session && owner.digest === digest) controller.abort()
    }
    // Bindings outlive this process: a restart revokes nothing. A stream whose binding moved to a
    // later session, or whose run token a renewal replaced, ends within `staleSweepMs`, a second
    // unless configured.
    yield* Effect.suspend(() => store.staleAmong(streams())).pipe(
      Effect.tap((stale) => Effect.sync(() => abortStale(stale))),
      Effect.catch(logFailure("Capability stream check failed")),
      Effect.andThen(Effect.sleep(config.staleSweepMs ?? 1000)),
      Effect.forever,
      Effect.forkScoped,
    )
    // Rows of expired run tokens and of expired used proofs go, now and every minute.
    yield* Effect.suspend(() => store.sweep(Date.now())).pipe(
      Effect.catch(logFailure("Capability sweep failed")),
      Effect.andThen(Effect.sleep("60 seconds")),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const runId of active.keys()) abortRun(runId)
      }),
    )
    const jobKeys = cachedJobKeys(keys)
    const mints = yield* Semaphore.make(maxMints)
    const issue = (deadline: number) =>
      ownedPromise((signal) =>
        mintCapability(
          config.noscope,
          "run-capability",
          "run",
          Math.min(tokenLifeMs / 1000, Math.floor((deadline - Date.now()) / 1000)),
          signal,
        ),
      ).pipe(
        mints.withPermitsIfAvailable(1),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new MintsBusy()),
            onSome: Effect.succeed,
          }),
        ),
      )
    /**
     * A renewal is checked before its mint and again when its successor is stored. Asked again
     * for the same predecessor, it replaces the successor that has not renewed itself.
     */
    const renewal = Effect.fn("CapabilityGateway.renewal")(function* (
      binding: { readonly runId: string; readonly channel: string },
      predecessor: string,
    ) {
      const previous = yield* authority.withPermit(
        store.renewable(
          binding,
          predecessor,
          (deadline) => Math.min(Date.now() + tokenLifeMs, deadline),
          Date.now(),
        ),
      )
      const next = yield* issue(previous.deadline)
      yield* authority.withPermit(
        store.renew(binding, predecessor, capabilityDigest(next.token), next.expiresAt, Date.now()),
      )
      return { token: next.token, expiresAt: next.expiresAt, renewAt: renewAt(next.expiresAt) }
    })
    const sessionChallenge = Effect.fn("CapabilityGateway.sessionChallenge")((lease: string) =>
      store.leaseChallenge(lease, Date.now()),
    )
    /**
     * The runner's OIDC proof for `workflowd:<channel>:<nonce>` opens the run's next session. The
     * answer can be lost after it is sent; the runner then proves itself again for a new challenge,
     * and that session ends every token of this one. Nothing here depends on seeing the client.
     */
    const session = Effect.fn("CapabilityGateway.session")(function* (proof: unknown) {
      const { token } = yield* Schema.decodeUnknownEffect(SessionProof)(proof, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new CapabilityRefused()))
      const claims = proofClaims(token)
      if (!claims) return yield* Effect.fail(new CapabilityRefused())
      const job = yield* store.sessionContext(claims, Date.now())
      const jwks = yield* Effect.tryPromise(() => jobKeys(claims.kid))
      const policy = job.policy
      const ref = `refs/heads/workflowd/leases/${job.leaseId}`
      const verified = yield* Effect.try({
        catch: () => new CapabilityRefused(),
        try: () =>
          verifyJobProof(
            token,
            {
              audience: claims.audience,
              repository: policy.repository,
              repositoryId: policy.repositoryId,
              ownerId: policy.privateBootstrap.repositoryOwnerId,
              actorId: policy.appActorId,
              ref,
              workflowSha: policy.workflowSha,
              toolingSha: policy.toolingSha ?? policy.workflowSha,
              workflowRef: `${policy.repository}/.github/workflows/agent-sandbox-caller.yml@${ref}`,
              jobWorkflowRef:
                policy.toolingSha === undefined
                  ? `${policy.repository}/.github/workflows/agent-sandbox.yml@${ref}`
                  : `BNasraoui/workflowd/.github/workflows/agent-sandbox.yml@${policy.toolingSha}`,
              runId: job.actionsRunId,
              attempt: job.actionsAttempt,
            },
            jwks,
            Date.now(),
          ),
      })
      const issued = yield* issue(job.deadline)
      yield* authority.withPermit(
        store.bindSession(
          {
            runId: job.runId,
            channel: claims.channel,
            nonce: claims.nonce,
            recipientId: job.recipientId,
          },
          verified.jti,
          capabilityDigest(issued.token),
          issued.expiresAt,
          Date.now(),
          verified.expiresAt,
        ),
      )
      const grant = { ...issued, renewAt: renewAt(issued.expiresAt) }
      return {
        token: grant.token,
        expiresAt: grant.expiresAt,
        renewAt: grant.renewAt,
        deadline: job.deadline,
      }
    })
    const revoke = Effect.fn("CapabilityGateway.revoke")((runId: string) =>
      authority.change(
        runId,
        store.revoke(runId).pipe(Effect.ensuring(Effect.sync(() => abortRun(runId)))),
      ),
    )
    type Binding = { readonly runId: string; readonly channel: string }
    type Grant = Effect.Success<ReturnType<typeof store.authorize>>
    /** The renew route: an empty JSON body, and the successor of the presented token. */
    const renewRoute = Effect.fn("CapabilityGateway.renewRoute")(function* (
      request: Request,
      binding: Binding,
      digest: string,
    ) {
      if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 2)
        return denied()
      const body = yield* ownedPromise((signal) =>
        readRequestBody(
          request,
          AbortSignal.any([signal, request.signal, AbortSignal.timeout(10000)]),
          2,
        ),
      ).pipe(Effect.result)
      if (body._tag === "Failure" || body.success.toString("utf8") !== "{}") return denied()
      // A refused renewal is final for this token; only a busy or failed mint or store is 503.
      const renewed = yield* Effect.result(renewal(binding, digest))
      if (renewed._tag === "Failure")
        return renewed.failure instanceof CapabilityRefused ? denied() : unavailable()
      return Response.json(renewed.success, { headers: { "cache-control": "no-store" } })
    })
    /**
     * Admits one stream of a run, under the run-lifetime fence: null when the gateway or the run
     * holds its most streams. The stream ends at the token's expiry or the run's deadline, after
     * `streamIdleMs` without a chunk, at the provider credential's expiry, or when the run changes.
     */
    const admit = (binding: Binding, session: number, digest: string, grant: Grant) =>
      authority.withPermit(
        Effect.gen(function* () {
          yield* store.authorize(binding, digest, Date.now())
          const owned =
            active.get(binding.runId) ??
            new Map<AbortController, { readonly session: number; readonly digest: string }>()
          if (count >= config.maxStreams || owned.size >= config.maxStreamsPerRun) return null
          const controller = new AbortController()
          owned.set(controller, { session, digest })
          active.set(binding.runId, owned)
          count++
          const unlisten = authority.listen(binding.runId, () => controller.abort())
          const timer = setTimeout(
            () => controller.abort(),
            Math.max(0, Math.min(grant.expiresAt - Date.now(), grant.deadline - Date.now())),
          )
          let idleTimer = setTimeout(() => controller.abort(), streamIdleMs)
          let providerTimer: ReturnType<typeof setTimeout> | undefined
          let released = false
          const release = () => {
            if (released) return
            released = true
            unlisten()
            clearTimeout(timer)
            clearTimeout(idleTimer)
            clearTimeout(providerTimer)
            active.get(binding.runId)?.delete(controller)
            if (active.get(binding.runId)?.size === 0) active.delete(binding.runId)
            count--
            controller.abort()
          }
          return {
            controller,
            release,
            transferred: false,
            touch: () => {
              if (released) return
              clearTimeout(idleTimer)
              idleTimer = setTimeout(() => controller.abort(), streamIdleMs)
            },
            providerExpiry: (expiry: number) => {
              providerTimer = setTimeout(() => controller.abort(), Math.max(0, expiry - Date.now()))
            },
          }
        }),
      )
    type Ownership = NonNullable<Effect.Success<ReturnType<typeof admit>>>
    /**
     * The upstream body as the client's body: at most 32 MiB, each chunk restarts the idle timer,
     * and an abort or a failed read ends it with an error and releases the stream.
     */
    const boundedBody = (
      selected: { readonly response: Response; readonly headers: Headers },
      signal: AbortSignal,
      ownership: Ownership,
    ) => {
      const { release } = ownership
      if (!selected.response.body) {
        release()
        return new Response(null, {
          status: selected.response.status,
          headers: selected.headers,
        })
      }
      const reader = selected.response.body.getReader()
      let bytes = 0
      const abort = () => {
        void reader.cancel().then(release, release)
      }
      signal.addEventListener("abort", abort, { once: true })
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(destination) {
            try {
              signal.throwIfAborted()
              const item = await reader.read()
              signal.throwIfAborted()
              if (item.done) {
                destination.close()
                signal.removeEventListener("abort", abort)
                release()
                return
              }
              const chunk: unknown = item.value
              if (!(chunk instanceof Uint8Array)) throw new Error("response refused")
              ownership.touch()
              bytes += chunk.length
              if (bytes > 32 * 1048576) throw new Error("response capacity")
              destination.enqueue(chunk)
            } catch {
              destination.error(new Error("capability stream interrupted"))
              signal.removeEventListener("abort", abort)
              try {
                await reader.cancel()
              } finally {
                release()
              }
            }
          },
          async cancel() {
            signal.removeEventListener("abort", abort)
            try {
              await reader.cancel()
            } finally {
              release()
            }
          },
        },
        { highWaterMark: 1 },
      )
      return new Response(body, {
        status: selected.response.status,
        headers: selected.headers,
      })
    }
    /**
     * Sends an admitted request upstream through its route: the Git read of the saved repository,
     * or the Claude call with a provider credential. Each upstream launch is checked again under
     * the run-lifetime fence. A refused request is "refused"; any other failure is "unavailable".
     */
    const forward = (
      request: Request,
      route:
        | { readonly git: true; readonly target: string }
        | { readonly git: false; readonly path: string },
      grant: Grant,
      binding: Binding,
      digest: string,
      ownership: Ownership,
    ) =>
      ownedPromise(async (interruption) => {
        const signal = AbortSignal.any([ownership.controller.signal, request.signal, interruption])
        const send = async (start: () => Promise<Response>) => {
          // Admission and launch share the run-lifetime fence; network waiting does not.
          const started = await Effect.runPromise(
            authority.withPermit(
              Effect.gen(function* () {
                yield* store.authorize(binding, digest, Date.now())
                return yield* Effect.try(() => {
                  signal.throwIfAborted()
                  return { response: start() }
                })
              }),
            ),
            { signal },
          )
          return await started.response
        }
        const selected = route.git
          ? await gitReadRequest(request, route.target, grant, signal, (url, input) =>
              send(() => gitUpstream(url, input)),
            )
          : await claudeRequest(
              request,
              route.path,
              grant.modelId,
              async () => {
                const snapshot = await mintCapability(
                  config.noscope,
                  "provider-access",
                  config.credentialRole,
                  3600,
                  signal,
                ).catch(async (error: unknown) => {
                  const provider = custodyProvider(config.credentialRole)
                  const fault =
                    config.login && provider
                      ? await loginFault(config.login.directory, provider)
                      : undefined
                  if (fault) console.error(fault)
                  throw error
                })
                ownership.providerExpiry(snapshot.expiresAt)
                return snapshot.token
              },
              signal,
              (url, input) => send(() => upstream(url, input)),
            )
        if (signal.aborted) {
          await selected.response.body?.cancel()
          signal.throwIfAborted()
        }
        return boundedBody(selected, signal, ownership)
      }).pipe(
        Effect.catch((error) =>
          error instanceof RequestRefused
            ? Effect.fail("refused" as const)
            : logFailure("Capability route failed")(error).pipe(
                Effect.andThen(Effect.fail("unavailable" as const)),
              ),
        ),
      )
    /**
     * A run's call. Its run token selects and authorizes its binding before any body is read; then
     * the renew route, or one admitted stream of the Git or Claude route.
     */
    const handle = Effect.fn("CapabilityGateway.handle")(
      function* (request: Request) {
        const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
        if (!auth?.[1] || !request.url.startsWith(`${capabilityOrigin}/`)) return denied()
        const digest = capabilityDigest(auth[1])
        // The run token alone selects its binding; no route reads a body before this check.
        const found = yield* Effect.result(store.bindingFor(digest, Date.now()))
        if (found._tag === "Failure") return denied()
        const { session, ...binding } = found.success
        const checked = yield* Effect.result(
          authority.withPermit(store.authorize(binding, digest, Date.now())),
        )
        if (checked._tag === "Failure") return denied()
        const grant = checked.success
        if (grant.providerId !== config.providerId) return denied()
        const target = request.url.slice(capabilityOrigin.length)
        if (target === "/capabilities/v1/renew") return yield* renewRoute(request, binding, digest)
        const prefix = `/capabilities/v1/providers/${config.providerId}`
        const isGit = config.gitRead === true && target.startsWith("/capabilities/v1/git/")
        if (!isGit && !target.startsWith(`${prefix}/`)) return denied()
        const route = isGit
          ? { git: true as const, target }
          : { git: false as const, path: target.slice(prefix.length) }
        return yield* Effect.acquireUseRelease(
          admit(binding, session, digest, grant),
          (ownership) =>
            Effect.gen(function* () {
              if (!ownership)
                return new Response(null, { status: 429, headers: { "retry-after": "1" } })
              const result = yield* Effect.result(
                forward(request, route, grant, binding, digest, ownership),
              )
              if (result._tag === "Success") {
                ownership.transferred = true
                return result.success
              }
              ownership.release()
              return result.failure === "refused" ? denied() : unavailable()
            }),
          (ownership) =>
            Effect.sync(() => {
              if (ownership && !ownership.transferred) ownership.release()
            }),
        )
      },
      Effect.catch((error) =>
        logFailure("Capability request failed")(error).pipe(Effect.as(unavailable())),
      ),
    )
    /** workflowd's calls on the control socket. Each revoked run's open streams end at once. */
    const control: ControlTarget = {
      authorize: (grant) =>
        store
          .authorizeGrant(grant)
          .pipe(
            Effect.flatMap(({ runId, held }) =>
              held
                ? Effect.void
                : Effect.sync(() => abortRun(runId)).pipe(
                    Effect.andThen(Effect.fail(new CapabilityRefused())),
                  ),
            ),
          ),
      revoke,
      reconcile: (live) =>
        store.reconcileGrants(live).pipe(
          Effect.tap((revoked) =>
            Effect.sync(() => {
              for (const runId of revoked) abortRun(runId)
            }),
          ),
          Effect.asVoid,
        ),
      sessionBound: store.sessionBound,
    }
    return { sessionChallenge, session, revoke, control, handle }
  })

export const CapabilityGateway = Context.Service<
  Effect.Success<ReturnType<typeof makeCapabilityGateway>>
>("workflowd/CapabilityGateway")
