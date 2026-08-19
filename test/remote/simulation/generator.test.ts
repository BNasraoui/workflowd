import { expect, test } from "bun:test"
import {
  generateActions,
  minimizeActions,
  mulberry32,
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

  expect(minimal.actions).toEqual([{ type: "advance", milliseconds: 100 }])
  expect(minimal.truncated).toBe(false)
})

// Chunk deletion is the whole point of the change: a reproduction buried in a long schedule must
// cost far fewer candidates than one re-run per action, because each candidate is a full
// simulation re-run.
test("shrinking deletes chunks rather than paying one candidate per action", async () => {
  const actions: ReadonlyArray<SimulationAction> = [
    ...Array.from({ length: 200 }, () => ({ type: "cancel" }) as const),
    { type: "wrongHost" } as const,
    ...Array.from({ length: 200 }, () => ({ type: "cancel" }) as const),
  ]
  let candidates = 0

  const minimal = await minimizeActions(actions, async (candidate) => {
    candidates += 1
    return candidate.some((action) => action.type === "wrongHost")
  })

  expect(minimal.actions).toEqual([{ type: "wrongHost" }])
  expect(minimal.candidates).toBe(candidates)
  expect(candidates).toBeLessThan(actions.length / 4)
})

test("shrinking stops at the candidate budget and reports the best reduction so far", async () => {
  const actions: ReadonlyArray<SimulationAction> = Array.from(
    { length: 64 },
    () => ({ type: "cancel" }) as const,
  )

  const minimal = await minimizeActions(actions, async (candidate) => candidate.length >= 4, {
    maxCandidates: 3,
  })

  expect(minimal.truncated).toBe(true)
  expect(minimal.candidates).toBe(3)
  expect(minimal.actions.length).toBeLessThan(actions.length)
})

test("a longer-run budget parses explicit seeds and bounded steps", () => {
  expect(simulationBudget({ seeds: "1,49,24301", steps: "100" })).toEqual({
    seeds: [1, 49, 24301],
    steps: 100,
  })
})

// Replay determinism is a contract: recorded seeds must reproduce byte-identical PRNG draws and
// action schedules forever, so these expectations are pinned rather than derived.
const pinnedDraws: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [
  [
    0x000000,
    [
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
      0.46732782293111086, 0.5450490827206522, 0.6152513844426721, 0.6489853798411787,
    ],
  ],
  [
    0x000001,
    [
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
      0.9683778982143849, 0.281103502959013, 0.6128388606011868, 0.7207431411370635,
    ],
  ],
  [
    0x000031,
    [
      0.37396135926246643, 0.6052912706509233, 0.777686869027093, 0.11377980140969157,
      0.509097256930545, 0.2087238875683397, 0.43362579215317965, 0.8602870153263211,
    ],
  ],
  [
    0x005eed,
    [
      0.7100320369936526, 0.286336648510769, 0.9519026265479624, 0.10175976227037609,
      0.3784139291383326, 0.6541043182369322, 0.31417828681878746, 0.307874359190464,
    ],
  ],
  [
    0xb3b009,
    [
      0.6576667777262628, 0.9466523034498096, 0.09306650492362678, 0.35414976300671697,
      0.7223038256634027, 0.9569227304309607, 0.779907472198829, 0.9216381444130093,
    ],
  ],
  [
    0xffffffff,
    [
      0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677,
      0.8452364315744489, 0.5391399988438934, 0.6804977387655526, 0.4755720964167267,
    ],
  ],
]

test.each(pinnedDraws)("seed %d draws the pinned mulberry32 sequence", (seed, expected) => {
  const random = mulberry32(seed)

  expect(expected.map(() => random())).toEqual([...expected])
})

const pinnedTraces: ReadonlyArray<readonly [number, string]> = [
  [
    0x000000,
    "seed=0 duplicate:host,runner:runner-a,disconnect:runner-b,reconnect:runner-b,reorder:result,duplicate:host,staleResult,reorder:result,restart:coordinator,restart:runner-b,coordinator,duplicate:result",
  ],
  [
    0x000001,
    "seed=1 restart:runner-a,disconnect:coordinator,wrongHost,duplicate:result,advance:100,wrongHost,reorder:host,coordinator,reorder:host,runner:runner-a,enqueue:runner-a,advance:100",
  ],
  [
    0x000031,
    "seed=49 delay:result,cancel,coordinator,disconnect:runner-a,reorder:result,enqueue:runner-a,restart:runner-b,reconnect:runner-a,delay:result,delay:host,delay:result,restart:coordinator",
  ],
  [
    0x005eed,
    "seed=24301 advance:100,wrongHost,coordinator,delay:result,delay:host,reconnect:runner-b,wrongHost,reorder:result,reorder:host,reconnect:coordinator,cancel,runner:runner-a",
  ],
  [
    0xb3b009,
    "seed=11776009 restart:coordinator,coordinator,delay:result,wrongHost,cancel,staleResult,restart:runner-a,runner:runner-a,runner:runner-b,cancel,duplicate:result,runner:runner-a",
  ],
]

test.each(pinnedTraces)("seed %d generates the pinned action schedule", (seed, expected) => {
  expect(replayTrace(seed, generateActions(seed, 12))).toBe(expected)
})
