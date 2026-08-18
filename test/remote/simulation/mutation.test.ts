import { expect, test } from "bun:test"
import { generateActions, replayTrace } from "./generator"
import { minimizeSimulationFailure } from "./simulator"

test("the harness finds and minimizes a command-before-fence ordering mutation", async () => {
  const seed = 2_624
  const actions = generateActions(seed, 5)

  const minimal = await minimizeSimulationFailure(seed, actions, {
    singleMessageBatches: true,
  })

  expect(replayTrace(seed, minimal)).toBe("seed=2624 enqueue:runner-b,coordinator,reorder:host")
}, 15_000)
