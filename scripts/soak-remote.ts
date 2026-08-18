import { simulationBudget } from "../test/remote/simulation/generator"
import { runSimulationSeed } from "../test/remote/simulation/simulator"

// Drives the remote simulation outside `bun test` so long soaks are not bounded by a test timeout.
async function main() {
  const budget = simulationBudget({
    ...(process.env.WORKFLOWD_SIM_SEEDS === undefined
      ? {}
      : { seeds: process.env.WORKFLOWD_SIM_SEEDS }),
    ...(process.env.WORKFLOWD_SIM_STEPS === undefined
      ? {}
      : { steps: process.env.WORKFLOWD_SIM_STEPS }),
  })
  console.log(`soak seeds=${budget.seeds.length} steps=${budget.steps}`)
  let failed = 0
  for (const seed of budget.seeds) {
    const started = Bun.nanoseconds()
    try {
      const summary = await runSimulationSeed(seed, budget.steps)
      const elapsed = (Bun.nanoseconds() - started) / 1e6
      const settled = summary.terminal === summary.accepted
      if (!settled) failed += 1
      console.log(
        `${settled ? "ok" : "FAIL"} seed=${seed} steps=${budget.steps} ` +
          `accepted=${summary.accepted} terminal=${summary.terminal} ` +
          `ms=${elapsed.toFixed(0)} perStepMs=${(elapsed / budget.steps).toFixed(1)}`,
      )
    } catch (cause) {
      failed += 1
      const elapsed = (Bun.nanoseconds() - started) / 1e6
      console.log(`FAIL seed=${seed} steps=${budget.steps} ms=${elapsed.toFixed(0)} threw`)
      console.error(cause)
    }
  }
  console.log(`soak complete seeds=${budget.seeds.length} failed=${failed}`)
  if (failed > 0) process.exitCode = 1
}

if (import.meta.main) await main()
