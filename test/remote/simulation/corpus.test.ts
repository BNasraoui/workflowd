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

test(
  "fixed CI seed corpus settles recoverable generated schedules",
  async () => {
    for (const seed of budget.seeds) {
      const summary = await runSimulationSeed(seed, budget.steps)
      expect(summary.terminal).toBe(summary.accepted)
    }
  },
  Math.max(30_000, budget.seeds.length * budget.steps * 150),
)
