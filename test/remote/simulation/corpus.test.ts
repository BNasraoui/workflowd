import { expect, test } from "bun:test"
import { simulationBudget } from "./generator"
import { runSimulationSeed } from "./simulator"

const budget = simulationBudget({
  ...(process.env.WORKFLOWD_SIM_SEEDS === undefined
    ? {}
    : { seeds: process.env.WORKFLOWD_SIM_SEEDS }),
  ...(process.env.WORKFLOWD_SIM_STEPS === undefined
    ? {}
    : { steps: process.env.WORKFLOWD_SIM_STEPS }),
})

// Worst observed cost is ~400ms per step on the slowest supported machine, so 600ms adds headroom.
// A failing seed additionally pays for shrinking, which is unbounded here; long runs should use
// `bun run soak:remote`, which has no test timeout at all.
const millisecondsPerStep = 600
const defaultTimeout = Math.max(30_000, budget.seeds.length * budget.steps * millisecondsPerStep)
const timeout =
  process.env.WORKFLOWD_SIM_TIMEOUT_MS === undefined
    ? defaultTimeout
    : Number(process.env.WORKFLOWD_SIM_TIMEOUT_MS)
if (!Number.isSafeInteger(timeout) || timeout < 1) {
  throw new Error("WORKFLOWD_SIM_TIMEOUT_MS must be a positive integer number of milliseconds")
}

test(
  "fixed CI seed corpus settles recoverable generated schedules",
  async () => {
    for (const seed of budget.seeds) {
      const summary = await runSimulationSeed(seed, budget.steps)
      expect(summary.terminal).toBe(summary.accepted)
    }
  },
  timeout,
)
