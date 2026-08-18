import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { runRemoteEnqueueProcess } from "../../src/remote-enqueue"
import { runRemoteRunnerProcess } from "../../src/remote-runner"

type RunnableProgram = Effect.Effect<void, Error, never>

const captureExit = (
  start: (runMain: (program: RunnableProgram) => void) => void,
): Promise<Exit.Exit<void, Error>> => {
  let execution: Promise<Exit.Exit<void, Error>> | undefined
  start((program) => {
    execution = Effect.runPromiseExit(program)
  })
  if (execution === undefined) throw new Error("entrypoint did not start its Effect program")
  return execution
}

test("remote enqueue entrypoint rejects a missing probe before opening its store", async () => {
  const exit = await captureExit((runMain) =>
    runRemoteEnqueueProcess({ argv: ["bun", "src/remote-enqueue.ts"], runMain }),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("--probe is required")
})

test("remote runner entrypoint reports invalid environment configuration", async () => {
  const exit = await captureExit((runMain) => runRemoteRunnerProcess({ env: {}, runMain }))

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.pretty(exit.cause)).toContain("Invalid remote configuration")
    expect(Cause.pretty(exit.cause)).toContain("WORKFLOWD_NATS_TOKEN")
  }
})
