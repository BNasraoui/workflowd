import { Clock, Effect, Schema } from "effect"

const RateResponse = Schema.Struct({
  status: Schema.Number,
  message: Schema.optional(Schema.String),
  response: Schema.optional(
    Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
  ),
})

// Shared by scans, suite discovery and restart recovery in one App adapter.
// Do not retry writes: an exhausted request fails closed, while subsequent
// requests wait until GitHub's reset/retry-after deadline.
export const makeIdentityRequest = () => {
  let resumeAt = 0
  const scans = new Map<number, number[]>()
  return <A>(run: (signal: AbortSignal) => Promise<A>, scanInstallationId?: number) =>
    Effect.gen(function* () {
      let now = yield* Clock.currentTimeMillis
      while (now < resumeAt) {
        yield* Effect.sleep(resumeAt - now)
        now = yield* Clock.currentTimeMillis
      }
      if (scanInstallationId !== undefined) {
        // A rolling window avoids a double burst at an hourly reset. Charge
        // before issuing I/O, including failed requests; concurrent scans share
        // this synchronous reservation. Publication must remain available.
        const recent = (scans.get(scanInstallationId) ?? []).filter(
          (time) => time > now - 3_600_000,
        )
        scans.set(scanInstallationId, recent)
        if (recent.length >= 1000)
          return yield* Effect.fail(new Error("scan budget exhausted, retry later"))
        recent.push(now)
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
