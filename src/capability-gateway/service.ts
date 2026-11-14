import { Cache, Context, Duration, Effect, Exit, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomInt } from "node:crypto"
import type { SandboxTransport } from "../sandbox/transport"
import { mintCapability, type NoscopeConfiguration } from "./noscope"
import { claudeRequest, readRequestBody, type ClaudeUpstream } from "./claude"
import { capabilityDigest, makeCapabilityStore, type CapabilityBinding } from "./store"
import { runLifetime } from "../store/run-lifetime"
import { ownedPromise } from "./owned"
import {
  makeNativeResultStore,
  NativeResultRequest,
  NativeFinalizationRequest,
} from "../sandbox/native-result"
import { makeNativeExecutionStore } from "../sandbox/native-execution"
import { nativeResponseObservation } from "./native-observation"
import { codexRequest } from "./codex"
import { opencodeRequest } from "./opencode"
import type { CapabilityGatewayConfig } from "../sandbox/config"
import { saveSandboxFile } from "../sandbox/binding"
import { gitReadRequest, type GitUpstream } from "./git"
import type { makeTokenBroker } from "../worker-identity/broker"

export interface GatewayConfiguration {
  readonly gitRead?: boolean
  readonly native?: CapabilityGatewayConfig["native"]
  readonly noscope: NoscopeConfiguration
  readonly providerId: string
  readonly credentialRole: string
  readonly maxStreams: number
  readonly maxStreamsPerRun: number
}
const RenewalKey = Schema.Struct({
  runId: Schema.String,
  channel: Schema.String,
  predecessor: Schema.String,
})
const denied = () => new Response(null, { status: 403 })
const unavailable = () => new Response(null, { status: 503, headers: { "retry-after": "5" } })

/** Owns run authority and stream lifetime. No administrative HTTP listener shares this interface. */
export const makeCapabilityGateway = (
  config: GatewayConfiguration,
  upstream: ClaudeUpstream = fetch,
  git?: {
    readonly broker?: Effect.Success<ReturnType<typeof makeTokenBroker>>
    readonly upstream?: GitUpstream
  },
) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(config.maxStreams) ||
      config.maxStreams < 1 ||
      config.maxStreams > 512 ||
      !Number.isSafeInteger(config.maxStreamsPerRun) ||
      config.maxStreamsPerRun < 1 ||
      config.maxStreamsPerRun > config.maxStreams
    )
      return yield* Effect.fail(new Error("gateway limits refused"))
    const store = yield* makeCapabilityStore
    const results = yield* makeNativeResultStore
    const native = yield* makeNativeExecutionStore
    const sql = yield* SqlClient.SqlClient
    const authority = runLifetime(sql)
    const active = new Map<string, Set<AbortController>>()
    let count = 0
    const abortRun = (runId: string) => {
      for (const controller of active.get(runId) ?? []) controller.abort()
    }
    // First bounded mode has no same-job restart survival. Revoke before exposing any handler.
    yield* store.revokeAll()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const runId of active.keys()) abortRun(runId)
      }),
    )
    const issue = (deadline: number) =>
      ownedPromise((signal) =>
        mintCapability(
          config.noscope,
          "run-capability",
          "run",
          Math.min(3600, Math.floor((deadline - Date.now()) / 1000)),
          signal,
        ),
      )
    const renewals = yield* Cache.makeWith(
      (key: string) =>
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RenewalKey))(key)
          const previous = yield* store.authorize(input, input.predecessor, Date.now())
          const next = yield* issue(previous.deadline)
          yield* authority.withPermit(
            store.renew(
              input,
              input.predecessor,
              capabilityDigest(next.token),
              next.expiresAt,
              Date.now(),
            ),
          )
          return {
            ...next,
            renewAt: Math.min(next.expiresAt, Date.now() + randomInt(45 * 60000, 55 * 60000)),
            predecessorExpiresAt: previous.expiresAt,
          }
        }),
      {
        capacity: 1024,
        timeToLive: (exit) =>
          Exit.isSuccess(exit)
            ? Duration.millis(Math.max(0, exit.value.predecessorExpiresAt - Date.now()))
            : Duration.zero,
      },
    )
    const challenge = Effect.fn("CapabilityGateway.challenge")(
      (runId: string, transport: SandboxTransport) => store.challenge(runId, transport, Date.now()),
    )
    const bind = Effect.fn("CapabilityGateway.bind")(function* (
      job: Effect.Success<ReturnType<typeof challenge>>,
      jti: string,
    ) {
      const token = yield* issue(job.deadline)
      const binding = yield* authority.withPermit(
        store.bind(job, jti, capabilityDigest(token.token), token.expiresAt, Date.now()),
      )
      return {
        binding,
        ...token,
        renewAt: Math.min(token.expiresAt, Date.now() + randomInt(45 * 60000, 55 * 60000)),
      }
    })
    const revoke = Effect.fn("CapabilityGateway.revoke")((runId: string) =>
      authority.change(
        runId,
        store.revoke(runId).pipe(Effect.ensuring(Effect.sync(() => abortRun(runId)))),
      ),
    )
    const handle = Effect.fn("CapabilityGateway.handle")(
      function* (binding: CapabilityBinding, request: Request) {
        const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
        if (!auth?.[1] || !request.url.startsWith("http://capability.invalid/")) return denied()
        const digest = capabilityDigest(auth[1])
        const checked = yield* Effect.result(
          authority.withPermit(store.authorize(binding, digest, Date.now())),
        )
        if (checked._tag === "Failure") return denied()
        const grant = checked.success
        if (grant.providerId !== config.providerId) return denied()
        const target = request.url.slice("http://capability.invalid".length)
        if (target === "/capabilities/v1/renew") {
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
          const renewed = yield* Cache.get(
            renewals,
            JSON.stringify({ ...binding, predecessor: digest }),
          )
          // Recheck even cached successors after cancellation; retries never reopen authority.
          yield* store.authorize(binding, digest, Date.now())
          return Response.json(
            { token: renewed.token, expiresAt: renewed.expiresAt, renewAt: renewed.renewAt },
            { headers: { "cache-control": "no-store" } },
          )
        }
        const prefix = `/capabilities/v1/providers/${config.providerId}`
        const isResult = target === "/capabilities/v1/result"
        const isGit = config.gitRead === true && target.startsWith("/capabilities/v1/git/")
        if (!isResult && !isGit && !target.startsWith(`${prefix}/`)) return denied()
        const running = yield* native.read(binding.runId)
        if (running && !["launching", "running"].includes(running.state)) return denied()
        if (
          config.native &&
          (!running ||
            !config.native.models.some(
              (model) =>
                model.id === grant.modelId &&
                model.efforts.some((effort) => effort === running.effort),
            ))
        )
          return denied()
        return yield* Effect.acquireUseRelease(
          authority.withPermit(
            Effect.gen(function* () {
              yield* store.authorize(binding, digest, Date.now())
              const invocation = yield* native.read(binding.runId)
              if (invocation && !["launching", "running"].includes(invocation.state))
                return yield* Effect.fail(new Error("Native invocation inactive"))
              const owned = active.get(binding.runId) ?? new Set<AbortController>()
              if (count >= config.maxStreams || owned.size >= config.maxStreamsPerRun) return null
              const controller = new AbortController()
              owned.add(controller)
              active.set(binding.runId, owned)
              count++
              const unlisten = authority.listen(binding.runId, () => controller.abort())
              const timer = setTimeout(
                () => controller.abort(),
                Math.max(
                  0,
                  Math.min(120000, grant.expiresAt - Date.now(), grant.deadline - Date.now()),
                ),
              )
              let providerTimer: ReturnType<typeof setTimeout> | undefined
              let released = false
              const release = () => {
                if (released) return
                released = true
                unlisten()
                clearTimeout(timer)
                clearTimeout(providerTimer)
                active.get(binding.runId)?.delete(controller)
                if (active.get(binding.runId)?.size === 0) active.delete(binding.runId)
                count--
                controller.abort()
              }
              return {
                invocation,
                controller,
                release,
                transferred: false,
                providerExpiry: (expiry: number) => {
                  providerTimer = setTimeout(
                    () => controller.abort(),
                    Math.max(0, expiry - Date.now()),
                  )
                },
              }
            }),
          ),
          (ownership) =>
            Effect.gen(function* () {
              if (!ownership)
                return new Response(null, { status: 429, headers: { "retry-after": "1" } })
              const { controller, release } = ownership
              if (isResult) {
                if (
                  request.method !== "POST" ||
                  request.headers.get("content-type") !== "application/json"
                )
                  return new Response(null, { status: 400 })
                const decoded = yield* ownedPromise((signal) =>
                  readRequestBody(
                    request,
                    AbortSignal.any([
                      signal,
                      controller.signal,
                      request.signal,
                      AbortSignal.timeout(10000),
                    ]),
                    65536,
                  ),
                ).pipe(
                  Effect.flatMap((body) =>
                    Schema.decodeUnknownEffect(
                      Schema.fromJsonString(
                        Schema.Union([NativeResultRequest, NativeFinalizationRequest]),
                      ),
                    )(body.toString("utf8"), { onExcessProperty: "error" }),
                  ),
                  Effect.result,
                )
                if (decoded._tag === "Failure") return new Response(null, { status: 400 })
                const revision = yield* authority.withPermit(
                  Effect.gen(function* () {
                    const currentGrant = yield* store.authorize(binding, digest, Date.now())
                    const invocation = yield* native.read(binding.runId)
                    if (
                      controller.signal.aborted ||
                      request.signal.aborted ||
                      invocation?.nonce !== ownership.invocation?.nonce ||
                      invocation?.generation !== ownership.invocation?.generation ||
                      (invocation &&
                        (invocation.channel !== binding.channel ||
                          invocation.model !== currentGrant.modelId ||
                          !["launching", "running"].includes(invocation.state)))
                    )
                      return null
                    if ("operation" in decoded.success)
                      return invocation
                        ? yield* native.requestFinalization(
                            binding,
                            invocation.nonce,
                            invocation.generation,
                            decoded.success.revision,
                          )
                        : null
                    return yield* results.submit(binding, decoded.success)
                  }),
                )
                return revision === null
                  ? new Response(null, { status: 409 })
                  : Response.json({ revision }, { headers: { "cache-control": "no-store" } })
              }
              const invocation = ownership.invocation
              const result = yield* Effect.result(
                ownedPromise(async (interruption) => {
                  const signal = AbortSignal.any([controller.signal, request.signal, interruption])
                  const send = async (start: () => Promise<Response>) => {
                    // Admission and launch share the run-lifetime fence; network waiting does not.
                    const started = await Effect.runPromise(
                      authority.withPermit(
                        Effect.gen(function* () {
                          yield* store.authorize(binding, digest, Date.now())
                          const current = yield* native.read(binding.runId)
                          if (
                            current &&
                            (current.nonce !== invocation?.nonce ||
                              current.generation !== invocation?.generation ||
                              current.channel !== binding.channel ||
                              !["launching", "running"].includes(current.state))
                          )
                            return yield* Effect.fail(new Error("Native invocation inactive"))
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
                  const adapter =
                    config.native?.protocol === "codex-chatgpt"
                      ? codexRequest
                      : config.native?.protocol === "openai-chat"
                        ? opencodeRequest
                        : claudeRequest
                  const selected = isGit
                    ? await gitReadRequest(
                        request,
                        target,
                        grant,
                        async () => {
                          if (!git?.broker) return undefined
                          const snapshot = await Effect.runPromise(
                            git.broker({
                              repository: grant.repositoryName,
                              installationId: grant.installationId,
                              permissions: { contents: "read" },
                            }),
                            { signal },
                          )
                          ownership.providerExpiry(snapshot.expiresAt)
                          return Redacted.value(snapshot.token)
                        },
                        signal,
                        (url, input) => send(() => (git?.upstream ?? fetch)(url, input)),
                      )
                    : await adapter(
                        request,
                        target.slice(prefix.length),
                        grant.modelId,
                        async () => {
                          const snapshot = await mintCapability(
                            config.noscope,
                            "provider-access",
                            config.credentialRole,
                            3600,
                            signal,
                          )
                          ownership.providerExpiry(snapshot.expiresAt)
                          return snapshot.token
                        },
                        signal,
                        (url, input) => send(() => upstream(url, input)),
                        invocation?.channel === binding.channel &&
                          ["launching", "running"].includes(invocation.state)
                          ? invocation.session_id
                          : undefined,
                        invocation?.effort,
                        async (evidence) => {
                          const rows = await Effect.runPromise(
                            sql`SELECT directory FROM kernel_agent_runs WHERE run_id=${binding.runId}`,
                            { signal },
                          )
                          const directory = rows[0]?.directory
                          if (typeof directory !== "string")
                            throw new Error("Private custody unavailable")
                          // Two fixed, bounded latest snapshots follow the run's existing private
                          // custody/retention. Neither is in the remote workspace or public projection.
                          await saveSandboxFile(
                            directory,
                            evidence.status >= 300
                              ? "provider-error.json"
                              : "provider-response.json",
                            JSON.stringify(evidence),
                          )
                        },
                      )
                  if (signal.aborted) {
                    await selected.response.body?.cancel()
                    signal.throwIfAborted()
                  }
                  if (!selected.response.body) {
                    release()
                    return new Response(null, {
                      status: selected.response.status,
                      headers: selected.headers,
                    })
                  }
                  const reader = selected.response.body.getReader()
                  const observe =
                    invocation &&
                    selected.selectionObserved &&
                    selected.response.status === 200 &&
                    selected.headers.get("content-type")?.startsWith("text/event-stream")
                      ? nativeResponseObservation(
                          invocation.model,
                          (tokens) =>
                            Effect.runPromise(
                              native.observeResponse(
                                binding.runId,
                                invocation.nonce,
                                invocation.model,
                                tokens,
                              ),
                              { signal },
                            ),
                          config.native?.protocol,
                        )
                      : undefined
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
                          bytes += chunk.length
                          if (bytes > 32 * 1048576) throw new Error("response capacity")
                          await observe?.(chunk)
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
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof Error && error.message === "request refused"
                      ? ("refused" as const)
                      : ("unavailable" as const),
                  ),
                ),
              )
              if (result._tag === "Success") {
                ownership.transferred = true
                return result.success
              }
              release()
              return result.failure === "refused" ? denied() : unavailable()
            }),
          (ownership) =>
            Effect.sync(() => {
              if (ownership && !ownership.transferred) ownership.release()
            }),
        )
      },
      Effect.catch(() => Effect.succeed(unavailable())),
    )
    return { challenge, bind, revoke, handle }
  })

export const CapabilityGateway = Context.Service<
  Effect.Success<ReturnType<typeof makeCapabilityGateway>>
>("workflowd/CapabilityGateway")
