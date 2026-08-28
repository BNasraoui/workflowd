// Nothing a simulation test asserts depends on the clock. Schedules are generated from a seed, the
// harness advances a virtual clock only when an `advance` action says so, shrinking stops at a
// candidate budget, and quiescence stops at a round budget sized from outstanding work. The only
// job a test timeout has here is to turn a genuine hang into a failure rather than a stuck CI job.
//
// That makes a tight timeout pure downside: it cannot catch a wrong result, but it does fail when
// the process is descheduled while the rest of the suite competes for the CPU. Both simulation
// flakes seen so far were exactly that -- a 15s cap on work costing ~4s unloaded, and Bun's 5s
// default on work costing ~0.5s unloaded. Saturating an 8-core laptop measured a ~5x slowdown for
// these files, and the reported failure durations imply ~20x on a fully contended machine, so
// unloaded cost is scaled by 32 and floored well above process startup and the first SQLite
// bootstrap. A slow machine can then only ever be slow, never wrong.
const loadTolerance = 32
const floorMs = 60_000
const overrideVariable = "WORKFLOWD_SIM_TIMEOUT_MS"

/**
 * Turn a measured unloaded cost into a test timeout that survives a loaded machine.
 * `WORKFLOWD_SIM_TIMEOUT_MS` replaces the derived value outright, for machines slower than the
 * tolerance above or for deliberately shortening a run.
 */
export const simulationTimeoutMs = (unloadedMs: number) => {
  const override = process.env[overrideVariable]
  if (override !== undefined) {
    const requested = Number(override)
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new Error(`${overrideVariable} must be a positive integer number of milliseconds`)
    }
    return requested
  }
  if (!Number.isFinite(unloadedMs) || unloadedMs < 0) {
    throw new Error("simulationTimeoutMs requires a non-negative unloaded cost in milliseconds")
  }
  return Math.max(floorMs, Math.ceil(unloadedMs * loadTolerance))
}

// Unloaded cost of one simulation step, measured over the default corpus (three seeds at twenty
// steps, 1.4s). Callers multiply by their own step count; `simulationTimeoutMs` supplies the load
// headroom, so this stays an honest unloaded figure rather than a pre-padded one.
export const unloadedMillisecondsPerStep = 25
