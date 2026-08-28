import { expect, test } from "bun:test"
import { simulationTimeoutMs, unloadedMillisecondsPerStep } from "./budget"
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

// A failing seed additionally pays for shrinking, which is bounded by candidates rather than by
// steps; long runs should use `bun run soak:remote`, which has no test timeout at all.
const timeout = simulationTimeoutMs(
  budget.seeds.length * budget.steps * unloadedMillisecondsPerStep,
)

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
