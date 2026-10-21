import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Logger } from "effect"
import { TestClock } from "effect/testing"
import { startPullRequestAvailability } from "../src/pr-availability"
import { OpenCodeAutomationError } from "../src/opencode"
import { OpenCodeAvailabilityError } from "../src/opencode/adapter"
import { WorkSignalLive } from "../src/work-signal"
import { automationStub } from "./helpers/runtime"

test("a missing fixer leaves reviews available and fixes wait without blocking disableFixJob", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const monitors = yield* startPullRequestAvailability(
          {
            ...automationStub(),
            validateAvailability: (input) =>
              input.kind === "fix"
                ? Effect.fail(
                    new OpenCodeAutomationError({
                      operation: "validate OpenCode availability",
                      cause: new OpenCodeAvailabilityError(["agent pr-fixer"]),
                      retryable: true,
                    }),
                  )
                : Effect.void,
          },
          true,
          true,
        )
        yield* TestClock.adjust("2 seconds")
        expect(yield* monitors.review.health).toEqual({ status: "available" })
        expect(yield* monitors.fix.health).toMatchObject({
          status: "misconfigured",
          missing: ["agent pr-fixer"],
        })
        expect(yield* monitors.availableJobKinds).toEqual(["review"])
        const disabled = yield* startPullRequestAvailability(
          { ...automationStub(), validateAvailability: () => Effect.never },
          true,
          false,
        )
        expect(yield* disabled.availableJobKinds).toEqual(["fix"])
      }),
    ).pipe(
      Effect.provide(WorkSignalLive),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([])),
    ),
  )
})

test("missing Automation produces an explicit startup error", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(startPullRequestAvailability(undefined, true, false)).pipe(
      Effect.provide(WorkSignalLive),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.pretty(exit.cause)).toContain("Automation service is required")
    expect(Cause.pretty(exit.cause)).not.toContain("NoSuchElementError")
  }
})
