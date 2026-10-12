import type { App } from "@octokit/app"
import { Cause, Clock, Context, Data, Duration, Effect, Queue, Schedule, Schema } from "effect"
import { validateInstallationAccountIds } from "./installation-policy"
import { WorkflowStore } from "./store/contracts"
import type { DeliveryInput } from "./store/model"

const Id = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Installation = Schema.Struct({
  id: Id,
  account: Schema.Struct({ id: Id, login: Schema.optionalKey(Schema.String) }),
})
type Installation = typeof Installation.Type
const InstallationPayload = Schema.Struct({ installation: Installation })
const isRateLimited = Schema.is(
  Schema.Struct({
    response: Schema.Struct({
      headers: Schema.Union([
        Schema.Struct({ "x-ratelimit-remaining": Schema.Literal("0") }),
        Schema.Struct({ "retry-after": Schema.String }),
        Schema.Struct({ "x-ratelimit-reset": Schema.String }),
      ]),
    }),
  }),
)

class InstallationApiError extends Data.TaggedError("InstallationApiError")<{
  readonly cause: unknown
  readonly status: number | undefined
}> {}

function apiError(cause: unknown) {
  const status =
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof cause.status === "number"
      ? cause.status
      : undefined
  return new InstallationApiError({ cause, status })
}

const RateHeaders = Schema.Struct({
  response: Schema.Struct({
    headers: Schema.Struct({
      "retry-after": Schema.optionalKey(Schema.String),
      "x-ratelimit-reset": Schema.optionalKey(Schema.String),
    }),
  }),
})

const retryDelay = (error: InstallationApiError, backoff: Duration.Duration) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(RateHeaders)(error.cause).pipe(Effect.option)
    if (decoded._tag === "None") return backoff
    const headers = decoded.value.response.headers
    const now = yield* Clock.currentTimeMillis
    const retryAfter = headers["retry-after"]
    const seconds = Number(retryAfter)
    const requested =
      retryAfter === undefined
        ? Number(headers["x-ratelimit-reset"]) * 1000 - now
        : Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - now
    return Number.isFinite(requested)
      ? Math.min(60000, Math.max(Duration.toMillis(backoff), requested))
      : backoff
  })

const logBackgroundFailure = (message: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logError(message, cause),
  )

const decodeInstallation = (input: unknown, source: string) =>
  Schema.decodeUnknownEffect(Installation)(input).pipe(
    Effect.catch(() => {
      const identity = Schema.decodeUnknownOption(Schema.Struct({ id: Id }))(input)
      return Effect.logInfo(
        `installation_guard ${JSON.stringify({
          installationId: identity._tag === "Some" ? identity.value.id : null,
          source,
          outcome: "undecodable",
        })}`,
      ).pipe(Effect.as(undefined))
    }),
  )

export const makeInstallationGuard = Effect.fn("InstallationGuard.make")(function* (
  accountIds: ReadonlyArray<number>,
  client: Pick<App["octokit"], "request">,
) {
  // Copy validated authority: empty/invalid lists never become "delete everything".
  const allowed = new Set(validateInstallationAccountIds(accountIds))
  const pending = yield* Queue.unbounded<{ installation: Installation; source: string }>()
  let lastSuccessfulReconciliationAt: number | null = null
  const health = () => Effect.sync(() => ({ lastSuccessfulReconciliationAt }))
  const request = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: apiError }).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) => (error instanceof InstallationApiError ? error : apiError(error))),
      Effect.retry({
        schedule: Schedule.exponential("1 second").pipe(
          Schedule.upTo({ times: 3 }),
          Schedule.setInputType<InstallationApiError>(),
          Schedule.modifyDelay(({ input, duration }) => retryDelay(input, duration)),
        ),
        while: (error) =>
          error.status === undefined ||
          error.status === 408 ||
          error.status === 429 ||
          (error.status === 403 && isRateLimited(error.cause)) ||
          error.status >= 500,
      }),
    )
  const audit = (installation: Installation, source: string, outcome: string) =>
    Effect.logInfo(
      `installation_guard ${JSON.stringify({ installationId: installation.id, accountId: installation.account.id, login: installation.account.login, source, outcome })}`,
    )

  const enforce = Effect.fn("InstallationGuard.enforce")(function* (
    installation: Installation,
    source: string,
  ) {
    if (allowed.has(installation.account.id)) {
      yield* audit(installation, source, "allowed")
      return "allowed" as const
    }
    const outcome = yield* request((signal) =>
      client.request("DELETE /app/installations/{installation_id}", {
        installation_id: installation.id,
        request: { signal },
      }),
    ).pipe(
      Effect.as("uninstalled" as const),
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed("already_gone" as const),
      ),
      Effect.tapError(() => audit(installation, source, "failed")),
    )
    yield* audit(installation, source, outcome)
    return outcome
  })

  const verify = (hint: Installation, source: string) =>
    Effect.gen(function* () {
      const response = yield* request((signal) =>
        client.request("GET /app/installations/{installation_id}", {
          installation_id: hint.id,
          request: { signal },
        }),
      )
      const verified = yield* decodeInstallation(response.data, source)
      if (verified === undefined) return "undecodable" as const
      if (verified.account.id !== hint.account.id && allowed.has(verified.account.id)) {
        yield* audit(verified, source, "account_mismatch_allowed")
        return "allowed" as const
      }
      return yield* enforce(verified, source)
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof InstallationApiError && error.status === 404,
        () => audit(hint, source, "already_gone").pipe(Effect.as("already_gone" as const)),
      ),
    )

  const handle = Effect.fn("InstallationGuard.handle")(function* (
    delivery: DeliveryInput,
    payload: unknown,
  ) {
    const targeted =
      (delivery.event === "installation" &&
        (delivery.action === "created" ||
          delivery.action === "unsuspend" ||
          delivery.action === "new_permissions_accepted")) ||
      (delivery.event === "installation_repositories" && delivery.action === "added")
    if (!targeted) return undefined
    const decoded = yield* Schema.decodeUnknownEffect(InstallationPayload)(payload)
    const store = yield* WorkflowStore
    // Durable claim before the API call. Reconciliation recovers a crash or
    // exhausted retry after this claim; duplicate deliveries never repeat it.
    if ((yield* store.recordDelivery(delivery)) === "duplicate") return "duplicate" as const
    const source = `webhook:${delivery.deliveryId}`
    yield* Queue.offer(pending, { installation: decoded.installation, source })
    return "accepted" as const
  })

  const runWebhooks = Effect.forever(
    Queue.take(pending).pipe(
      Effect.flatMap(({ installation, source }) =>
        verify(installation, source).pipe(
          logBackgroundFailure(`Installation webhook failed (${source})`),
        ),
      ),
    ),
  )

  const reconcile = Effect.fn("InstallationGuard.reconcile")(function* () {
    const installations: Installation[] = []
    let next = true
    for (let page = 1; next; page++) {
      const response = yield* request((signal) =>
        client.request("GET /app/installations", {
          per_page: 100,
          page,
          request: { signal },
        }),
      )
      const items = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(response.data)
      for (const item of items) {
        const installation = yield* decodeInstallation(item, "reconcile")
        if (installation !== undefined) installations.push(installation)
      }
      next = response.headers.link?.includes('rel="next"') === true
    }
    // Finish pagination before mutation, or deletion can shift page boundaries.
    const outcomes = yield* Effect.forEach(installations, (installation) =>
      enforce(installation, "reconcile").pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    )
    const successful = outcomes.every(Boolean)
    if (successful) lastSuccessfulReconciliationAt = yield* Clock.currentTimeMillis
    return successful
  })
  return { handle, reconcile, runWebhooks, health }
})

export const InstallationGuard = Context.Service<
  Effect.Success<ReturnType<typeof makeInstallationGuard>>
>("workflowd/InstallationGuard")

export const startInstallationGuard = Effect.fn("InstallationGuard.start")(function* (
  guard: Effect.Success<ReturnType<typeof makeInstallationGuard>>,
) {
  yield* guard.runWebhooks.pipe(Effect.forkScoped)
  let failures = 0
  const pass = Effect.suspend(() => guard.reconcile()).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Installation reconciliation failed", cause).pipe(Effect.as(false)),
    ),
    Effect.map((successful) => {
      failures = successful ? 0 : Math.min(failures + 1, 4)
      return Math.min(3600000, 600000 * 2 ** Math.max(0, failures - 1))
    }),
  )
  return yield* pass.pipe(
    Effect.repeat(
      Schedule.spaced("10 minutes").pipe(
        Schedule.setInputType<number>(),
        Schedule.modifyDelay(({ input }) => Effect.succeed(input)),
      ),
    ),
    Effect.forkScoped,
  )
})
