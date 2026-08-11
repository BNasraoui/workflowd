import { Context, Effect, Layer, PubSub, Queue, type Scope } from "effect"

export type WorkLane = "job" | "publication" | "reconciliation" | "command"

export type WorkSignalSubscription = {
  readonly wait: Effect.Effect<void>
}

export type SchedulerPort = {
  readonly subscribe: (lane: WorkLane) => Effect.Effect<WorkSignalSubscription, never, Scope.Scope>
  readonly signal: (lane: WorkLane) => Effect.Effect<void>
}

export const Scheduler = Context.GenericTag<SchedulerPort>("workflowd/Scheduler")

export const SchedulerLive = Layer.scoped(
  Scheduler,
  Effect.gen(function* () {
    const makeLane = Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
    const lanes = {
      job: yield* makeLane,
      publication: yield* makeLane,
      reconciliation: yield* makeLane,
      command: yield* makeLane,
    }

    return {
      subscribe: (lane) =>
        PubSub.subscribe(lanes[lane]).pipe(
          Effect.map((subscription) => ({ wait: Queue.take(subscription).pipe(Effect.asVoid) })),
        ),
      signal: (lane) => PubSub.publish(lanes[lane], undefined).pipe(Effect.asVoid),
    }
  }),
)
