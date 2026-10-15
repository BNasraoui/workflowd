import { Clock, Effect, Schema } from "effect"

const RateResponse = Schema.Struct({
  status: Schema.Number,
  message: Schema.optional(Schema.String),
  response: Schema.optional(
    Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
  ),
})

export type IdentityBudget = {
  readonly kind?: "read" | "start" | "finish"
  readonly prKey?: string
  readonly authorKey?: string | undefined
}

// Shared by scans, suite discovery and restart recovery in one App adapter.
// Do not retry writes: an exhausted request fails closed, while subsequent
// requests wait until GitHub's reset/retry-after deadline.
export const makeIdentityRequest = () => {
  let resumeAt = 0
  const windows = new Map<
    string,
    Array<{ time: number; prKey: string | undefined; authorKey: string | undefined }>
  >()
  return <A>(
    run: (signal: AbortSignal) => Promise<A>,
    installationId?: number,
    budget: IdentityBudget = {},
  ) =>
    Effect.gen(function* () {
      let now = yield* Clock.currentTimeMillis
      while (now < resumeAt) {
        yield* Effect.sleep(resumeAt - now)
        now = yield* Clock.currentTimeMillis
      }
      if (installationId !== undefined) {
        // Separate write allowances reserve completion capacity even after a
        // read or start flood. Failed I/O is charged before concurrent callers
        // can reserve the same slot. A rerun reset is also a check start.
        const kind = budget.kind ?? "read"
        const limits = { read: [1000, 250], start: [100, 25], finish: [200, 50] } as const
        const [installationLimit, prLimit] = limits[kind]
        const key = `${installationId}/${kind}`
        const recent = (windows.get(key) ?? []).filter(({ time }) => time > now - 3_600_000)
        windows.set(key, recent)
        // Rerun payloads omit the PR author. Reuse the author from recent
        // reservations, and charge the initial lookup once its response is known.
        const related =
          budget.prKey === undefined
            ? []
            : ["read", "start", "finish"].flatMap((kind) =>
                (windows.get(`${installationId}/${kind}`) ?? []).filter(
                  (entry) => entry.time > now - 3_600_000 && entry.prKey === budget.prKey,
                ),
              )
        const authorKey =
          budget.authorKey ?? related.findLast((entry) => entry.authorKey !== undefined)?.authorKey
        if (authorKey !== undefined) for (const entry of related) entry.authorKey ??= authorKey
        const prRequests = recent.filter(({ prKey }) => prKey === budget.prKey).length
        if (
          recent.length >= installationLimit ||
          (budget.prKey !== undefined && prRequests >= prLimit) ||
          (authorKey !== undefined &&
            recent.filter((entry) => entry.authorKey === authorKey).length >= prLimit)
        )
          return yield* Effect.fail(new Error("scan budget exhausted, retry later"))
        recent.push({ time: now, prKey: budget.prKey, authorKey })
      }
      return yield* Effect.tryPromise({
        try: run,
        catch: (cause) => new Error("Git identity check unavailable", { cause }),
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const response = error.cause
            if (Schema.is(RateResponse)(response)) {
              const headers = response.response?.headers ?? {}
              if (
                response.status === 429 ||
                (response.status === 403 &&
                  (headers["x-ratelimit-remaining"] === "0" ||
                    headers["retry-after"] !== undefined ||
                    /rate limit/i.test(response.message ?? "")))
              ) {
                const time = yield* Clock.currentTimeMillis
                const retry = Number(headers["retry-after"])
                const reset = Number(headers["x-ratelimit-reset"])
                resumeAt = Math.max(
                  resumeAt,
                  time + 60_000,
                  Number.isFinite(retry) ? time + retry * 1000 : 0,
                  Number.isFinite(reset) ? reset * 1000 : 0,
                )
              }
            }
            return yield* Effect.fail(new Error("Git identity check unavailable"))
          }),
        ),
      )
    })
}
export type IdentityRequest = ReturnType<typeof makeIdentityRequest>
