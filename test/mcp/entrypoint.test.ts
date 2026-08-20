import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { runMcpServerProcess } from "../../src/mcp-server"

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

test("MCP entrypoint rejects an invalid port before opening its store", async () => {
  const exit = await captureExit((runMain) =>
    runMcpServerProcess({ env: { WORKFLOWD_MCP_PORT: "not-a-port" }, runMain }),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.pretty(exit.cause)).toContain("WORKFLOWD_MCP_PORT must be an integer")
  }
})

test("MCP entrypoint rejects conflicting token sources before serving", async () => {
  const exit = await captureExit((runMain) =>
    runMcpServerProcess({
      env: { WORKFLOWD_MCP_TOKEN: "a", WORKFLOWD_MCP_TOKEN_FILE: "/b" },
      runMain,
    }),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.pretty(exit.cause)).toContain("at most one of WORKFLOWD_MCP_TOKEN")
  }
})
