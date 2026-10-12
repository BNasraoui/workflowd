import { expect, test } from "bun:test"
import { Effect } from "effect"
import { observationFailure, observeSandboxStage } from "../../src/sandbox/observation"

test("observation classification bounds cyclic causes and omits arbitrary names and payloads", () => {
  const cause: { name: string; status: number; cause?: unknown } = {
    name: "credential-canary",
    status: 999,
  }
  cause.cause = cause
  const failure = observationFailure("binding", cause, Date.now())
  expect(failure.evidence).toMatchObject({
    stage: "binding",
    errorClass: "UnknownError",
    httpStatus: null,
  })
  expect(JSON.stringify(failure)).not.toContain("credential-canary")
  expect(JSON.stringify(failure.evidence).length).toBeLessThan(512)
})

test("observation wrappers keep the original stage and leave busy sessions successful", async () => {
  const original = observationFailure(
    "catalog",
    new SyntaxError("credential-canary"),
    Date.now() - 10,
  )
  expect(observationFailure("telemetry", { cause: original }, Date.now())).toBe(original)
  const telemetry = { idle: false, outputTokens: 23 }
  expect(
    await Effect.runPromise(observeSandboxStage("telemetry", Effect.succeed(telemetry))),
  ).toEqual(telemetry)
})
