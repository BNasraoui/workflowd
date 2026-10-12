import type { App } from "@octokit/app"
import { Context, Data, Effect, Schedule, Schema } from "effect"
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
  account: Schema.Struct({ id: Id, login: Schema.String }),
})
type Installation = typeof Installation.Type
const InstallationPayload = Schema.Struct({ installation: Installation })
const isRateLimited = Schema.is(
  Schema.Struct({
    response: Schema.Struct({
      headers: Schema.Union([
        Schema.Struct({ "x-ratelimit-remaining": Schema.Literal("0") }),
        Schema.Struct({ "retry-after": Schema.String }),
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

export function makeInstallationGuard(
  accountIds: ReadonlyArray<number>,
  client: Pick<App["octokit"], "request">,
) {
  // Copy validated authority: empty/invalid lists never become "delete everything".
  const allowed = new Set(validateInstallationAccountIds(accountIds))
  const request = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: apiError }).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) => (error instanceof InstallationApiError ? error : apiError(error))),
      Effect.retry({
        schedule: Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 3 })),
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

  const handle = Effect.fn("InstallationGuard.handle")(function* (
    delivery: DeliveryInput,
    payload: unknown,
  ) {
    const targeted =
      (delivery.event === "installation" &&
        (delivery.action === "created" || delivery.action === "new_permissions_accepted")) ||
      (delivery.event === "installation_repositories" && delivery.action === "added")
    if (!targeted) return undefined
    const decoded = yield* Schema.decodeUnknownEffect(InstallationPayload)(payload)
    const store = yield* WorkflowStore
    // Durable claim before the API call. Reconciliation recovers a crash or
    // exhausted retry after this claim; duplicate deliveries never repeat it.
    if ((yield* store.recordDelivery(delivery)) === "duplicate") return "duplicate" as const
    return yield* enforce(decoded.installation, `webhook:${delivery.deliveryId}`)
  })

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
      installations.push(
        ...(yield* Schema.decodeUnknownEffect(Schema.Array(Installation))(response.data)),
      )
      next = response.headers.link?.includes('rel="next"') === true
    }
    // Finish pagination before mutation, or deletion can shift page boundaries.
    yield* Effect.forEach(
      installations,
      (installation) => enforce(installation, "reconcile").pipe(Effect.ignore),
      { discard: true },
    )
  })
  return { handle, reconcile }
}

export const InstallationGuard = Context.Service<ReturnType<typeof makeInstallationGuard>>(
  "workflowd/InstallationGuard",
)

export const startInstallationGuard = Effect.fn("InstallationGuard.start")(function* (
  guard: ReturnType<typeof makeInstallationGuard>,
) {
  const pass = guard
    .reconcile()
    .pipe(Effect.catch((error) => Effect.logError("Installation reconciliation failed", error)))
  yield* pass
  yield* pass.pipe(
    Effect.repeat(Schedule.spaced("10 minutes")),
    Effect.delay("10 minutes"),
    Effect.forkScoped,
  )
})
