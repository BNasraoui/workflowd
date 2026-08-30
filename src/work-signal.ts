import { Context, Effect, Layer, PubSub, type Scope } from "effect"

export type WorkLane =
  | "job"
  | "agent-completion"
  | "agent-run"
  | "kernel-job"
  | "session-resume"
  | "publication"
  | "reconciliation"
  | "command"

export type WorkSignalPort = {
  readonly subscribe: (
    lane: WorkLane,
  ) => Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>
  readonly wake: (lane: WorkLane) => Effect.Effect<void>
}

export const WorkSignal = Context.Service<WorkSignalPort>("workflowd/WorkSignal")

export const WorkSignalLive = Layer.effect(
  WorkSignal,
  Effect.gen(function* () {
    const lanes = {
      job: yield* PubSub.sliding<void>(1),
      "agent-completion": yield* PubSub.sliding<void>(1),
      "agent-run": yield* PubSub.sliding<void>(1),
      "kernel-job": yield* PubSub.sliding<void>(1),
      "session-resume": yield* PubSub.sliding<void>(1),
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
