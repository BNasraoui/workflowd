import { Context, Effect, Option, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomInt } from "node:crypto"
import { mintCapability } from "./noscope"
import { custodyProvider, loginFault, renewalWriteBoundMs } from "./custody"
import {
  budgetHeld,
  budgetSpent,
  claudeRequest,
  NoProviderOutput,
  readRequestBody,
  RunBudgetHeld,
  RunBudgetSpent,
  type ClaudeUpstream,
  type ReportedUsage,
} from "./claude"
import {
  CapabilityRefused,
  CapabilityRetired,
  capabilityDigest,
  makeCapabilityStore,
  type SignedRenewal,
  twoHolders,
} from "./store"
import { githubJobKeys, verifyJobProof } from "../sandbox/bootstrap"
import { runLifetime } from "../store/run-lifetime"
import { ownedPromise } from "./owned"
import { makeRunRoutes, runRoutePrefix } from "./run-routes"
import { gitReadRequest, type GitUpstream } from "./git"
import type { ControlTarget } from "./control"
import {
  isSessionKey,
  maxRenewalBody,
  renewLeadMaxMs,
  renewLeadMinMs,
  sessionBinder,
} from "../../deploy/sandbox/renewal.mjs"
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
/** The period of the sweep of stale streams when the config names none. */
const defaultStaleSweepMs = 1000
const SessionProof = Schema.Struct({
  token: Schema.String.check(Schema.isMaxLength(maxProofLength)),
  key: Schema.String.check(Schema.makeFilter(isSessionKey)),
})
const SessionAudience = /^workflowd:([a-f0-9]{64}):([a-f0-9]{64})$/
/**
 * The body of a renewal: the request's attempt number and the time at which the relay signed it,
 * each as its exact decimal text, and the relay's signature of the renewal, that number and that
 * time with the session key.
 */
const RenewalBody = Schema.fromJsonString(
  Schema.Struct({ signature: Schema.String, attempt: Schema.String, time: Schema.String }),
)
/**
 * Reads the audience and jti of an unverified proof only to select its challenge, to check its
 * binder and to refuse a used proof early; verification follows.
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
      ? { audience: match[0], channel: match[1], binder: match[2], jti, kid }
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
export const maxMints = 4
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
/** A call waits this long for the provider's access value; the renewal it waits on goes on. */
const accessWaitMs = 10000
/** Noscope's run of custody ends after this: past custody's lock wait and request limit. */
const accessLimitMs = 30000
/** A fault line of one cause is written at most once in this time. */
const faultLogEveryMs = 60000
/** `shared`, or the reason of `signal` once it aborts first; `shared` goes on either way. */
const waitFor = <A>(shared: Promise<A>, signal: AbortSignal) =>
  new Promise<A>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("the call ended"))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    shared.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error instanceof Error ? error : new Error("no access value"))
      },
    )
  })
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
    const runRoute = (yield* makeRunRoutes)(store)
    // A reservation that an earlier process left open is charged in full before any call starts.
    yield* store.chargeOpenReservations()
    const sql = yield* SqlClient.SqlClient
    const authority = runLifetime(sql)
    // The gateway's lifetime: a renewal of the provider login ends with the gateway, never with
    // the call that started it.
    const lifetime = new AbortController()
    const custody = custodyProvider(config.credentialRole)
    const logged = new Map<string, number>()
    const logFault = (line: string) => {
      const now = Date.now()
      if (now - (logged.get(line) ?? -Infinity) < faultLogEveryMs) return
      logged.set(line, now)
      console.error(line)
    }
    /** Why custody gave no access value, as a line without any value; undefined when unknown. */
    const accessFault = async () => {
      if (!custody) return undefined
      if (!config.login)
        return `custody: the gateway's configuration names no login directory for ${custody}`
      return await loginFault(config.login.directory, custody)
    }
    // One run of the provider-access mint at a time: each call that needs it waits for that one.
    let inFlight: Promise<{ readonly token: string; readonly expiresAt: number }> | undefined
    const providerAccess = (signal: AbortSignal) => {
      inFlight ??= mintCapability(
        config.noscope,
        "provider-access",
        config.credentialRole,
        3600,
        lifetime.signal,
        accessLimitMs,
      )
        .catch(async (error: unknown) => {
          const fault = await accessFault()
          if (fault) logFault(fault)
          throw error
        })
        .finally(() => {
          inFlight = undefined
        })
      return waitFor(inFlight, AbortSignal.any([signal, AbortSignal.timeout(accessWaitMs)]))
    }
    // A stop waits for a renewal of the login in flight (custody's mint), up to the bound of its
    // request and its write, before it ends the gateway's lifetime: an answer that the stop cut
    // off would leave the stored refresh value one that the OAuth server has replaced. Custody
    // finishes such a renewal on SIGTERM itself, but where the end of the gateway kills each
    // process it leaves (the first process of a container, or a unit's main process with
    // `KillMode=mixed`), custody would end with it. A mint of another provider renews no login, and ends at once.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pending = inFlight
        if (pending && custody && config.login) {
          console.error("the gateway waits for a renewal in flight before it stops")
          yield* Effect.promise(() =>
            pending.then(
              () => undefined,
              () => undefined,
            ),
          ).pipe(Effect.timeoutOption(renewalWriteBoundMs))
        }
        lifetime.abort()
      }),
    )
    // Each live stream, by run, with the session and the digest of the token that opened it.
    const active = new Map<
      string,
      Map<AbortController, { readonly session: number; readonly digest: string }>
    >()
    let count = 0
    // The release of each admitted stream that has not ended, and each settlement not yet stored.
    const releases = new Set<() => void>()
    const settling = new Set<Promise<unknown>>()
    const settleReservation = (reservation: string, usage: ReportedUsage | undefined) => {
      const stored = Effect.runPromiseExit(
        store
          .settle(reservation, usage)
          .pipe(Effect.catch(logFailure("Capability settlement failed"))),
      )
      settling.add(stored)
      void stored.then(() => settling.delete(stored))
    }
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
      Effect.andThen(Effect.sleep(config.staleSweepMs ?? defaultStaleSweepMs)),
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
    // A stop releases each open stream, which settles its reservation, before the store closes.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const release of [...releases]) release()
      }).pipe(
        // Each settlement is an exit: it does not reject.
        Effect.andThen(
          Effect.promise(() =>
            Promise.all(settling).then(
              () => undefined,
              () => undefined,
            ),
          ),
        ),
      ),
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
     * A check of a renewal, under the run-lifetime fence. When it shows that the run has two
     * holders, the same transaction revokes the run with that reason, and its open streams end;
     * the renewal is then refused, and the gateway logs the run and the reason.
     */
    const decided = <A extends { readonly twoHolders: boolean }, E, R>(
      runId: string,
      check: Effect.Effect<A, E, R>,
    ) =>
      authority
        .withPermit(
          Effect.tap(check, ({ twoHolders: found }) =>
            found
              ? authority.change(
                  runId,
                  store
                    .revokeTwoHolders(runId)
                    .pipe(Effect.ensuring(Effect.sync(() => abortRun(runId)))),
                )
              : Effect.void,
          ),
        )
        .pipe(
          Effect.tap(({ twoHolders: found }) =>
            found
              ? Effect.logWarning("Capability run ended", { runId, reason: twoHolders }).pipe(
                  Effect.andThen(Effect.fail(new CapabilityRefused())),
                )
              : Effect.void,
          ),
        )
    /**
     * A renewal, signed by the session key with an attempt number higher than each taken, is
     * checked before its mint and again when its successor is stored. Asked again for the same
     * predecessor, it replaces the successor that has not renewed itself; a successor that has
     * authorized a call ends the run instead.
     */
    const renewal = Effect.fn("CapabilityGateway.renewal")(function* (
      binding: { readonly runId: string; readonly channel: string },
      predecessor: string,
      signed: SignedRenewal,
    ) {
      const previous = yield* decided(
        binding.runId,
        store.renewable(
          binding,
          predecessor,
          signed,
          (deadline) => Math.min(Date.now() + tokenLifeMs, deadline),
          Date.now(),
        ),
      )
      const next = yield* issue(previous.deadline)
      yield* decided(
        binding.runId,
        store.renew(
          binding,
          predecessor,
          signed,
          capabilityDigest(next.token),
          next.expiresAt,
          Date.now(),
        ),
      )
      return { token: next.token, expiresAt: next.expiresAt, renewAt: renewAt(next.expiresAt) }
    })
    const sessionChallenge = Effect.fn("CapabilityGateway.sessionChallenge")((lease: string) =>
      store.leaseChallenge(lease, Date.now()),
    )
    /**
     * The runner's OIDC proof for `workflowd:<channel>:<binder>`, with the session's public key,
     * opens the run's next session. The binder is that of the nonce that the gateway issued for
     * the channel and of the key; it is checked before any key is fetched or token minted. The
     * answer can be lost after it is sent; the runner then proves itself again for a new
     * challenge, and that session ends every token of this one. Nothing here depends on seeing
     * the client.
     */
    const session = Effect.fn("CapabilityGateway.session")(function* (proof: unknown) {
      const { token, key } = yield* Schema.decodeUnknownEffect(SessionProof)(proof, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new CapabilityRefused()))
      const claims = proofClaims(token)
      if (!claims) return yield* Effect.fail(new CapabilityRefused())
      const job = yield* store.sessionContext(claims, Date.now())
      if (sessionBinder(job.nonce, key) !== claims.binder)
        return yield* Effect.fail(new CapabilityRefused())
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
            nonce: job.nonce,
            recipientId: job.recipientId,
          },
          verified.jti,
          capabilityDigest(issued.token),
          issued.expiresAt,
          Date.now(),
          verified.expiresAt,
          key,
        ),
      )
      const grant = { ...issued, renewAt: renewAt(issued.expiresAt) }
      return {
        token: grant.token,
        expiresAt: grant.expiresAt,
        renewAt: grant.renewAt,
        deadline: job.deadline,
        providerId: config.providerId,
      }
    })
    const revoke = Effect.fn("CapabilityGateway.revoke")((runId: string) =>
      authority.change(
        runId,
        store.revoke(runId).pipe(Effect.ensuring(Effect.sync(() => abortRun(runId)))),
      ),
    )
    type Binding = { readonly runId: string; readonly channel: string }
    /**
     * The check of a run token again, at a later step of its call. A token refused there, revoked
     * or retired since the first check, is refused as at the first check.
     */
    const checkedAgain = (digest: string) =>
      store.authenticate(digest, Date.now()).pipe(
        Effect.catchIf(
          (error) => error instanceof CapabilityRefused || error instanceof CapabilityRetired,
          () => Effect.fail(new RequestRefused()),
        ),
      )
    type Grant = Effect.Success<ReturnType<typeof store.authenticate>>["grant"]
    /**
     * The renew route: a body of the relay's signature, attempt number and time, at most
     * `maxRenewalBody` bytes, and the successor of the presented token.
     */
    const renewRoute = Effect.fn("CapabilityGateway.renewRoute")(function* (
      request: Request,
      binding: Binding,
      digest: string,
    ) {
      if (
        request.method !== "POST" ||
        Number(request.headers.get("content-length") ?? 0) > maxRenewalBody
      )
        return denied()
      const body = yield* ownedPromise((signal) =>
        readRequestBody(
          request,
          AbortSignal.any([signal, request.signal, AbortSignal.timeout(10000)]),
          maxRenewalBody,
        ),
      ).pipe(
        Effect.flatMap((bytes) =>
          Schema.decodeUnknownEffect(RenewalBody)(bytes.toString("utf8"), {
            onExcessProperty: "error",
          }),
        ),
        Effect.result,
      )
      if (body._tag === "Failure") return denied()
      // A refused renewal is final for this token; only a busy or failed mint or store is 503.
      const renewed = yield* Effect.result(renewal(binding, digest, body.success))
      if (renewed._tag === "Failure")
        return renewed.failure instanceof CapabilityRefused ? denied() : unavailable()
      return Response.json(renewed.success, { headers: { "cache-control": "no-store" } })
    })
    /**
     * Admits one stream of a run, under the run-lifetime fence: null when the gateway or the run
     * holds its most streams. The stream ends at the token's expiry or the run's deadline, after
     * `streamIdleMs` without a chunk, at the provider credential's expiry, or when the run changes.
     * A stream that a run token opened before its successor's first call runs on after that call:
     * at most to the token's expiry, which is at most `renewalWindowMs` (330 s) after its renewal,
     * as no token is renewed earlier.
     */
    const admit = (binding: Binding, session: number, digest: string, grant: Grant) =>
      authority.withPermit(
        Effect.gen(function* () {
          yield* checkedAgain(digest)
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
          // The reservation of the stream's model call, settled once, at the stream's release.
          let reservation: string | undefined
          let usage: (() => ReportedUsage | undefined) | undefined
          const settle = () => {
            if (reservation !== undefined) settleReservation(reservation, usage?.())
          }
          const release = () => {
            if (released) return
            released = true
            releases.delete(release)
            settle()
            unlisten()
            clearTimeout(timer)
            clearTimeout(idleTimer)
            clearTimeout(providerTimer)
            active.get(binding.runId)?.delete(controller)
            if (active.get(binding.runId)?.size === 0) active.delete(binding.runId)
            count--
            controller.abort()
          }
          releases.add(release)
          return {
            controller,
            release,
            transferred: false,
            reserved: (id: string) => {
              reservation = id
              if (released) settle()
            },
            measured: (read: () => ReportedUsage | undefined) => {
              usage = read
            },
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
        /**
         * Launches an upstream request. A model call also counts against the run's budget and
         * reserves `tokens` of its output tokens, under the same hold of the run-lifetime permit
         * as its launch.
         */
        const send = async (start: () => Promise<Response>, tokens?: number) => {
          // Admission and launch share the run-lifetime fence; network waiting does not.
          const started = await Effect.runPromise(
            authority.withPermit(
              Effect.gen(function* () {
                yield* checkedAgain(digest)
                if (tokens !== undefined) {
                  const reserved = yield* store.reserve(binding.runId, tokens, Date.now())
                  if (reserved === "spent" || reserved === "held") return reserved
                  // The stream holds the reservation before the commit, so its release settles it
                  // whenever it comes; the settlement waits for the commit, and a reservation that
                  // is rolled back is no row: its settlement changes nothing.
                  ownership.reserved(reserved.reservation)
                }
                return yield* Effect.try(() => {
                  signal.throwIfAborted()
                  return { response: start() }
                })
              }),
            ),
            { signal },
          )
          if (started === "spent") throw new RunBudgetSpent()
          if (started === "held") throw new RunBudgetHeld()
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
                const snapshot = await providerAccess(signal)
                ownership.providerExpiry(snapshot.expiresAt)
                return snapshot.token
              },
              signal,
              (url, input, tokens) => send(() => upstream(url, input), tokens),
              grant.budget.maxTokens,
            ).then((call) => {
              ownership.measured(call.usage)
              return call
            })
        if (signal.aborted) {
          await selected.response.body?.cancel()
          signal.throwIfAborted()
        }
        return boundedBody(selected, signal, ownership)
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof RequestRefused) return Effect.fail("refused" as const)
          if (error instanceof RunBudgetSpent) return Effect.fail("spent" as const)
          if (error instanceof RunBudgetHeld) return Effect.fail("held" as const)
          // The release that follows settles the call's reservation with no output.
          if (error instanceof NoProviderOutput) ownership.measured(() => error.usage)
          return logFailure("Capability route failed")(error).pipe(
            Effect.andThen(Effect.fail("unavailable" as const)),
          )
        }),
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
        const target = request.url.slice(capabilityOrigin.length)
        // The run token alone selects its binding; no route reads a body before this check.
        const checked = yield* Effect.result(
          authority.withPermit(store.authenticate(digest, Date.now())),
        )
        // A token whose successor has authorized a call is refused; its signed renewal shows that
        // the run has two holders, and the renewal ends the run.
        if (
          checked._tag === "Failure" &&
          checked.failure instanceof CapabilityRetired &&
          target === "/capabilities/v1/renew"
        ) {
          const { runId, channel } = checked.failure
          return yield* renewRoute(request, { runId, channel }, digest)
        }
        if (checked._tag === "Failure") return denied()
        const { session, binding, grant } = checked.success
        if (grant.providerId !== config.providerId) return denied()
        if (target === "/capabilities/v1/renew") return yield* renewRoute(request, binding, digest)
        // A runner run's own routes: outside its budget, and never a stream.
        if (target.startsWith(runRoutePrefix))
          return yield* runRoute(request, target, binding, grant)
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
              if (result.failure === "spent") return budgetSpent()
              if (result.failure === "held") return budgetHeld()
              return result.failure === "refused" ? denied() : unavailable()
            }),
          (ownership) =>
            Effect.sync(() => {
              if (ownership && !ownership.transferred) ownership.release()
            }),
        ).pipe(
          Effect.catchIf(
            (error) => error instanceof RequestRefused,
            () => Effect.succeed(denied()),
          ),
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
      provider: Effect.succeed(config.providerId),
      sessionBound: store.sessionBound,
      readEvents: store.readEvents,
      readResult: store.readResult,
    }
    return { sessionChallenge, session, revoke, control, handle }
  })

export const CapabilityGateway = Context.Service<
  Effect.Success<ReturnType<typeof makeCapabilityGateway>>
>("workflowd/CapabilityGateway")
