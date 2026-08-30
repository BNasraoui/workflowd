import { afterEach, expect, test } from "bun:test"
import { simulationTimeoutMs, unloadedMillisecondsPerStep } from "./budget"

const restore = process.env.WORKFLOWD_SIM_TIMEOUT_MS

afterEach(() => {
  if (restore === undefined) delete process.env.WORKFLOWD_SIM_TIMEOUT_MS
  else process.env.WORKFLOWD_SIM_TIMEOUT_MS = restore
})

test("a cheap simulation still gets a floor far above process startup", () => {
  delete process.env.WORKFLOWD_SIM_TIMEOUT_MS

  expect(simulationTimeoutMs(0)).toBe(60_000)
  expect(simulationTimeoutMs(600)).toBe(60_000)
})

test("an expensive simulation scales past the floor with room for a loaded machine", () => {
  delete process.env.WORKFLOWD_SIM_TIMEOUT_MS

  const timeout = simulationTimeoutMs(4_000)

  expect(timeout).toBeGreaterThan(60_000)
  expect(timeout / 4_000).toBeGreaterThanOrEqual(20)
})

test("the per-step cost keeps the default corpus budget above its unloaded runtime", () => {
  delete process.env.WORKFLOWD_SIM_TIMEOUT_MS

  const steps = 3 * 20

  expect(simulationTimeoutMs(steps * unloadedMillisecondsPerStep)).toBeGreaterThanOrEqual(
    steps * unloadedMillisecondsPerStep * 20,
  )
})

test("an explicit override replaces the derived budget", () => {
  process.env.WORKFLOWD_SIM_TIMEOUT_MS = "1234"

  expect(simulationTimeoutMs(4_000)).toBe(1_234)
})

test("an unusable override is rejected rather than silently ignored", () => {
  for (const override of ["0", "-1", "1.5", "soon"]) {
    process.env.WORKFLOWD_SIM_TIMEOUT_MS = override

    expect(() => simulationTimeoutMs(600)).toThrow(
      "WORKFLOWD_SIM_TIMEOUT_MS must be a positive integer number of milliseconds",
    )
  }
})

test("a nonsensical unloaded cost is rejected rather than producing a bogus budget", () => {
  delete process.env.WORKFLOWD_SIM_TIMEOUT_MS

  expect(() => simulationTimeoutMs(-1)).toThrow(
    "simulationTimeoutMs requires a non-negative unloaded cost in milliseconds",
  )
  expect(() => simulationTimeoutMs(Number.NaN)).toThrow(
    "simulationTimeoutMs requires a non-negative unloaded cost in milliseconds",
  )
})
