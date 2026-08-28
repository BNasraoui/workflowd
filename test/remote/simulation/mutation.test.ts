import { expect, test } from "bun:test"
import { simulationTimeoutMs } from "./budget"
import { generateActions, replayTrace } from "./generator"
import { minimizeSimulationFailure } from "./simulator"

// Shrinking this seed costs a fixed 13 simulation re-runs (one baseline plus twelve candidates),
// measured at ~4s unloaded. The count is deterministic, so the timeout only has to absorb load.
const unloadedMs = 4_000

test(
  "the harness finds and minimizes a command-before-fence ordering mutation",
  async () => {
    const seed = 2_624
    const actions = generateActions(seed, 5)

    const minimal = await minimizeSimulationFailure(seed, actions, {
      singleMessageBatches: true,
    })

    expect(minimal.truncated).toBe(false)
    expect(replayTrace(seed, minimal.actions)).toBe(
      "seed=2624 enqueue:runner-b,coordinator,reorder:host",
    )
  },
  simulationTimeoutMs(unloadedMs),
)
