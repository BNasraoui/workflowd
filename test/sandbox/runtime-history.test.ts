import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Logger, Schema } from "effect"
import { loadConfig } from "../../src/config"
import { startHookService } from "../../src/runtime"
import { SandboxDispatch } from "../../src/sandbox/dispatch"
import { sandboxStage } from "../../src/sandbox/store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { kernelLayer } from "../kernel/job-store-harness"
import { WorkSignalLive } from "../../src/work-signal"

test("runtime logs the reconciliation failure cause while retaining the worker", async () => {
  const loaded = await loadConfig({ WORKFLOWD_MODE: "execution" }, { home: "/tmp" })
  const failure = await Effect.runPromise(
    sandboxStage(
      "dispatch.iteration",
      Schema.decodeUnknownEffect(
        Schema.Struct({
          policy: Schema.fromJsonString(Schema.Struct({ agentImage: Schema.String })),
        }),
      )({ policy: JSON.stringify({ agentImage: 123456789 }) }),
    ).pipe(Effect.flip),
  )
  const messages: unknown[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const logged = yield* Deferred.make<void>()
        yield* startHookService({
          ...loaded,
          http: { ...loaded.http, host: "127.0.0.1", port: 0 },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              KernelSessionStoreLive.pipe(Layer.provideMerge(kernelLayer(":memory:"))),
              WorkSignalLive,
              Logger.layer([
                Logger.make(({ message }) => {
                  messages.push(message)
                  if (
                    Array.isArray(message) &&
                    message[0] === "Sandbox reconciliation failed; saved custody retained"
                  )
                    Deferred.doneUnsafe(logged, Effect.void)
                }),
              ]),
              Layer.succeed(SandboxDispatch, {
                launch: () => Effect.die("unused"),
                cancel: () => Effect.die("unused"),
                observe: () => Effect.die("unused"),
                provider: () => Effect.die("unused"),
                owns: () => Effect.succeed(false),
                heartbeat: Effect.void,
                iteration: Effect.fail(failure),
              }),
            ),
          ),
        )
        yield* Deferred.await(logged)
      }),
    ),
  )
  expect(JSON.stringify(messages)).toContain("policy.agentImage")
  expect(JSON.stringify(messages)).not.toContain("123456789")
  expect(messages).toContainEqual([
    "Sandbox reconciliation failed; saved custody retained",
    failure,
  ])
})
