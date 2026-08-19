import { Context, Effect, Layer, PubSub, type Queue, type Scope } from "effect"

/** Every supervised worker lane, in the order operational status reports them. */
export const workLanes = ["job", "publication", "reconciliation", "command"] as const

export type WorkLane = (typeof workLanes)[number]

export type WorkSignalPort = {
  readonly subscribe: (lane: WorkLane) => Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope>
  readonly wake: (lane: WorkLane) => Effect.Effect<void>
}

export const WorkSignal = Context.GenericTag<WorkSignalPort>("workflowd/WorkSignal")

export const WorkSignalLive = Layer.scoped(
  WorkSignal,
  Effect.gen(function* () {
    const lanes = {
      job: yield* PubSub.sliding<void>(1),
      publication: yield* PubSub.sliding<void>(1),
      reconciliation: yield* PubSub.sliding<void>(1),
      command: yield* PubSub.sliding<void>(1),
    }
    yield* Effect.addFinalizer(() =>
      Effect.all(Object.values(lanes).map((lane) => PubSub.shutdown(lane))).pipe(Effect.asVoid),
    )
    return {
      subscribe: (lane) => PubSub.subscribe(lanes[lane]),
      wake: (lane) => PubSub.publish(lanes[lane], undefined).pipe(Effect.asVoid),
    }
  }),
)
