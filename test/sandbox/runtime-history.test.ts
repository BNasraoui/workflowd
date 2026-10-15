import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Logger } from "effect"
import { loadConfig } from "../../src/config"
import { startHookService } from "../../src/runtime"
import { SandboxDispatch } from "../../src/sandbox/dispatch"
import { SandboxError } from "../../src/sandbox/store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { kernelLayer } from "../kernel/job-store-harness"
import { WorkSignalLive } from "../../src/work-signal"

test("runtime logs the reconciliation failure cause while retaining the worker", async () => {
  const loaded = await loadConfig({ WORKFLOWD_MODE: "execution" }, { home: "/tmp" })
  const failure = new SandboxError({
    message: "Saved lease policy decode failed: agentImage missing",
  })
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
  expect(messages).toContainEqual([
    "Sandbox reconciliation failed; saved custody retained",
    failure,
  ])
})
