import { expect, test } from "bun:test"
import { inspect } from "node:util"
import { Effect, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { OpenCodeAutomationError } from "../src/opencode"
import { validateOpenCodeStartup } from "../src/startup-validation"

const unavailable = new OpenCodeAutomationError({
  operation: "validate OpenCode availability",
  cause: new Error("missing reviewer agent"),
  retryable: true,
})

test("startup retry warnings omit request URLs and nested causes", async () => {
  const requestUrl = "https://user:url-password@example.test/?token=url-token#url-fragment"
  const failure = new OpenCodeAutomationError({
    operation: "validate OpenCode availability",
    cause: new Error(`Request failed: ${requestUrl}`, {
      cause: { request: { url: requestUrl } },
    }),
    retryable: true,
  })
  const logs: unknown[] = []
  let attempts = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const startup = yield* validateOpenCodeStartup(
        Effect.suspend(() => (++attempts === 1 ? Effect.fail(failure) : Effect.void)),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(startup)
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
    ),
  )
  expect(attempts).toBe(2)
  expect(logs).toHaveLength(1)
  for (const rendered of [inspect(logs, { depth: null }), JSON.stringify(logs)]) {
    expect(rendered).toContain(failure.operation)
    expect(rendered).toContain("retrying")
    for (const secret of [requestUrl, "url-password", "url-token", "url-fragment"]) {
      expect(rendered).not.toContain(secret)
    }
  }
})

test("persistent unavailability fails within 30 seconds with the catalog error", async () => {
  let attempts = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const startup = yield* validateOpenCodeStartup(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail(unavailable)
        }),
      ).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      return yield* Fiber.join(startup)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(attempts).toBe(15)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.cause).toBe(unavailable)
})

test("a hung availability request is interrupted at the startup deadline", async () => {
  let interrupted = false
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const startup = yield* validateOpenCodeStartup(
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        ),
      ).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      return yield* Fiber.join(startup)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(interrupted).toBe(true)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.message).toContain("30 seconds")
})

test.each([
  { latency: "200 millis", expectedAttempts: 14 },
  { latency: "25 seconds", expectedAttempts: 2 },
])(
  "the deadline preserves the last failure with $latency per attempt",
  async ({ latency, expectedAttempts }) => {
    let attempts = 0
    let lastFailure = unavailable
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const startup = yield* validateOpenCodeStartup(
          Effect.gen(function* () {
            attempts += 1
            yield* Effect.sleep(latency)
            lastFailure = new OpenCodeAutomationError({
              operation: "validate OpenCode availability",
              cause: new Error(
                `attempt ${attempts}: Unavailable OpenCode integration: agent pr-reviewer, model zai-coding-plan/glm-5.3-flash`,
              ),
              retryable: true,
            })
            return yield* Effect.fail(lastFailure)
          }),
        ).pipe(Effect.result, Effect.forkChild)
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(startup)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(attempts).toBe(expectedAttempts)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.cause).toBe(lastFailure)
      expect(result.failure.message).toContain("30 seconds")
      expect(result.failure.message).toContain(lastFailure.operation)
      expect(result.failure.message).toContain(lastFailure.cause.message)
    }
  },
)
