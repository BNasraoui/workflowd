import { expect, test } from "bun:test"
import {
  generateActions,
  minimizeActions,
  replayTrace,
  simulationBudget,
  type SimulationAction,
} from "./generator"

test("a seed reproduces the same typed action schedule and replay trace", () => {
  const first = generateActions(0xb3b009, 24)
  const second = generateActions(0xb3b009, 24)

  expect(second).toEqual(first)
  expect(replayTrace(0xb3b009, first)).toBe(replayTrace(0xb3b009, second))
  expect(replayTrace(0xb3b009, first)).toStartWith("seed=11776009 ")
})

test("shrinking deletes irrelevant actions and reduces time values", async () => {
  const actions: ReadonlyArray<SimulationAction> = [
    { type: "enqueue", host: "runner-a" },
    { type: "advance", milliseconds: 10_000 },
    { type: "runner", host: "runner-b" },
  ]

  const minimal = await minimizeActions(actions, async (candidate) =>
    candidate.some((action) => action.type === "advance" && action.milliseconds >= 100),
  )

  expect(minimal).toEqual([{ type: "advance", milliseconds: 100 }])
})

test("a longer-run budget parses explicit seeds and bounded steps", () => {
  expect(simulationBudget({ seeds: "1,49,24301", steps: "100" })).toEqual({
    seeds: [1, 49, 24301],
    steps: 100,
  })
})
