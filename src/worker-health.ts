import { Context, Effect, Layer, Ref } from "effect"
import { workLanes, type WorkLane } from "./work-signal"

/**
 * Whether the supervised workers are working.
 *
 * A supervised lane never exits: `superviseWorker` catches every iteration
 * failure, logs it and loops. That keeps the listener answering while a broken
 * local dependency makes every claim fail, which is exactly the condition an
 * operator cannot see from liveness alone. This module is the in-memory record
 * of what each lane last did, and it is the only thing readiness asks about the
 * workers.
 *
 * A lane is shared by every worker running it, so one worker's success clears
 * the lane's failure streak. That is the intended reading: the lane is still
 * making progress even if one of its workers is not.
 */

/**
 * Consecutive failures before a lane counts as failing. It matches the retry
 * budget the durable queues use, so a lane is reported failing at the point a
 * piece of work would have exhausted its own attempts.
 */
export const consecutiveFailuresBeforeFailing = 3

export type WorkerLaneStatus = "starting" | "ok" | "failing"

export type WorkerLaneHealth = {
  readonly lane: WorkLane
  readonly status: WorkerLaneStatus
  readonly completedIterations: number
  readonly consecutiveFailures: number
}

export type WorkerHealthPort = {
  readonly recordIteration: (lane: WorkLane) => Effect.Effect<void>
  readonly recordFailure: (lane: WorkLane) => Effect.Effect<void>
  readonly report: Effect.Effect<ReadonlyArray<WorkerLaneHealth>>
}

export const WorkerHealth = Context.GenericTag<WorkerHealthPort>("workflowd/WorkerHealth")

type LaneRecord = {
  readonly completedIterations: number
  readonly consecutiveFailures: number
}

const startingLane: LaneRecord = { completedIterations: 0, consecutiveFailures: 0 }

function laneStatus(record: LaneRecord): WorkerLaneStatus {
  if (record.consecutiveFailures >= consecutiveFailuresBeforeFailing) return "failing"
  return record.completedIterations === 0 ? "starting" : "ok"
}

export const WorkerHealthLive = Layer.effect(
  WorkerHealth,
  Effect.gen(function* () {
    const lanes = yield* Ref.make<Record<WorkLane, LaneRecord>>({
      job: startingLane,
      publication: startingLane,
      reconciliation: startingLane,
      command: startingLane,
    })
    const update = (lane: WorkLane, next: (record: LaneRecord) => LaneRecord) =>
      Ref.update(lanes, (current) => ({ ...current, [lane]: next(current[lane]) }))
    return {
      recordIteration: (lane) =>
        update(lane, (record) => ({
          completedIterations: record.completedIterations + 1,
          consecutiveFailures: 0,
        })),
      recordFailure: (lane) =>
        update(lane, (record) => ({
          completedIterations: record.completedIterations,
          consecutiveFailures: record.consecutiveFailures + 1,
        })),
      report: Ref.get(lanes).pipe(
        Effect.map((current) =>
          workLanes.map((lane) => ({
            lane,
            status: laneStatus(current[lane]),
            completedIterations: current[lane].completedIterations,
            consecutiveFailures: current[lane].consecutiveFailures,
          })),
        ),
      ),
    }
  }),
)
