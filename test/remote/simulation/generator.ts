export type SimHost = "runner-a" | "runner-b"

export type SimulationAction =
  | { readonly type: "enqueue"; readonly host: SimHost }
  | { readonly type: "coordinator" }
  | { readonly type: "runner"; readonly host: SimHost }
  | { readonly type: "duplicate"; readonly channel: "host" | "result" }
  | { readonly type: "delay"; readonly channel: "host" | "result" }
  | { readonly type: "reorder"; readonly channel: "host" | "result" }
  | { readonly type: "disconnect"; readonly host: SimHost | "coordinator" }
  | { readonly type: "reconnect"; readonly host: SimHost | "coordinator" }
  | { readonly type: "restart"; readonly service: SimHost | "coordinator" }
  | { readonly type: "advance"; readonly milliseconds: number }
  | { readonly type: "cancel" }
  | { readonly type: "staleResult" }
  | { readonly type: "wrongHost" }

export const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    // Mulberry32 wraps the counter at 32 bits; this is deliberate overflow, not truncation.
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const choice = <A>(random: () => number, values: ReadonlyArray<A>): A =>
  values[Math.floor(random() * values.length)]!

export const generateActions = (seed: number, length: number): ReadonlyArray<SimulationAction> => {
  const random = mulberry32(seed)
  const host = () => choice(random, ["runner-a", "runner-b"] as const)
  const channel = () => choice(random, ["host", "result"] as const)
  const service = () => choice(random, ["runner-a", "runner-b", "coordinator"] as const)
  const generators: ReadonlyArray<() => SimulationAction> = [
    () => ({ type: "enqueue", host: host() }),
    () => ({ type: "coordinator" }),
    () => ({ type: "runner", host: host() }),
    () => ({ type: "duplicate", channel: channel() }),
    () => ({ type: "delay", channel: channel() }),
    () => ({ type: "reorder", channel: channel() }),
    () => ({ type: "disconnect", host: service() }),
    () => ({ type: "reconnect", host: service() }),
    () => ({ type: "restart", service: service() }),
    () => ({ type: "advance", milliseconds: choice(random, [1, 100, 1_000, 10_000]) }),
    () => ({ type: "cancel" }),
    () => ({ type: "staleResult" }),
    () => ({ type: "wrongHost" }),
  ]
  return Array.from({ length }, () => choice(random, generators)())
}

const actionTrace = (action: SimulationAction) => {
  switch (action.type) {
    case "enqueue":
    case "runner":
      return `${action.type}:${action.host}`
    case "duplicate":
    case "delay":
    case "reorder":
      return `${action.type}:${action.channel}`
    case "disconnect":
    case "reconnect":
      return `${action.type}:${action.host}`
    case "restart":
      return `${action.type}:${action.service}`
    case "advance":
      return `advance:${action.milliseconds}`
    case "coordinator":
    case "cancel":
    case "staleResult":
    case "wrongHost":
      return action.type
  }
}

export const replayTrace = (seed: number, actions: ReadonlyArray<SimulationAction>) =>
  `seed=${seed} ${actions.map(actionTrace).join(",")}`

export type ShrinkBudget = {
  readonly maxCandidates?: number
}

export type ShrinkResult = {
  readonly actions: ReadonlyArray<SimulationAction>
  readonly candidates: number
  readonly truncated: boolean
}

// Every candidate costs a full simulation re-run, so the candidate count is the whole cost model.
// Deleting one action at a time needs one re-run per action: ~500 re-runs for a 500-action
// schedule, measured at 46.9 minutes for seed 1, which reads as a hang. Delta debugging deletes
// halves, then quarters, then eighths, and only falls back to single actions once coarse deletions
// stop shrinking, so a reproduction that is a small subset of the schedule is reached in far fewer
// re-runs. The stopping condition is unchanged -- the loop only gives up once no single action can
// be removed -- so the result is still 1-minimal.
//
// The budget counts candidates rather than wall-clock time deliberately: a clock cap would make
// the reduction depend on machine load, and a recorded seed has to shrink to the same schedule on
// every replay.
export const defaultShrinkCandidates = 200

export const minimizeActions = async (
  actions: ReadonlyArray<SimulationAction>,
  stillFails: (candidate: ReadonlyArray<SimulationAction>) => Promise<boolean>,
  budget: ShrinkBudget = {},
): Promise<ShrinkResult> => {
  const maxCandidates = budget.maxCandidates ?? defaultShrinkCandidates
  let minimal = [...actions]
  let candidates = 0
  let truncated = false
  const reproduces = async (candidate: ReadonlyArray<SimulationAction>) => {
    if (candidates >= maxCandidates) {
      truncated = true
      return false
    }
    candidates += 1
    return await stillFails(candidate)
  }
  const deleteChunks = async () => {
    // Granularity is how many chunks the schedule is cut into: 2 (halves), 4, 8, ... up to one
    // chunk per action. A successful deletion steps granularity back down, because the shorter
    // schedule may tolerate a proportionally coarser cut again.
    let granularity = 2
    while (minimal.length >= 2) {
      const size = Math.ceil(minimal.length / granularity)
      let reduced = false
      for (let start = 0; start < minimal.length; start += size) {
        const candidate = minimal.toSpliced(start, size)
        if (await reproduces(candidate)) {
          minimal = candidate
          reduced = true
          break
        }
        if (truncated) return
      }
      if (reduced) granularity = Math.max(2, Math.min(granularity - 1, minimal.length))
      else if (granularity >= minimal.length) return
      else granularity = Math.min(granularity * 2, minimal.length)
    }
  }
  const shrinkValues = async () => {
    for (let index = 0; index < minimal.length; index += 1) {
      const action = minimal[index]!
      if (action.type !== "advance") continue
      for (const milliseconds of [1, 100, 1_000]) {
        if (milliseconds >= action.milliseconds) break
        const candidate = minimal.with(index, { type: "advance", milliseconds })
        if (await reproduces(candidate)) {
          minimal = candidate
          break
        }
        if (truncated) return
      }
    }
  }
  await deleteChunks()
  await shrinkValues()
  await deleteChunks()
  return { actions: minimal, candidates, truncated }
}

export const simulationBudget = (input: { readonly seeds?: string; readonly steps?: string }) => {
  const seedText = input.seeds ?? `${0xb3b009},${0x31},${0x5eed}`
  const seeds = seedText.split(",").map(Number)
  const steps = Number(input.steps ?? 20)
  if (
    seedText.length === 0 ||
    seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0) ||
    !Number.isSafeInteger(steps) ||
    steps < 1 ||
    steps > 500
  ) {
    throw new Error("simulation budget requires non-negative integer seeds and 1..500 steps")
  }
  return { seeds, steps }
}
