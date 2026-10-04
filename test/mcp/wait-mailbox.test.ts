import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { startMcpServer, type StartedMcpServer } from "../../src/mcp-server"
import { removeDatabase, runKernel } from "../kernel/job-store-harness"

const databasePath = "test-wait-mailbox.db"
const message = {
  task: "RPI questions finished",
  terminal: {
    run_id: "run-test",
    mailbox_id: "mailbox-test",
    status: "succeeded",
    final_message: "https://gist.github.com/example/questions",
  },
}
let started: StartedMcpServer

beforeAll(async () => {
  await removeDatabase(databasePath)
  started = await Effect.runPromise(
    startMcpServer({
      WORKFLOWD_MCP_PORT: "0",
      WORKFLOWD_DATABASE_PATH: databasePath,
      WORKFLOWD_MCP_TOKEN: "integration-token",
    }),
  )
  await runKernel(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO resident_inbox(id,thread_id,mailbox_id,prompt,state)
        VALUES('mailbox-message-test',NULL,'mailbox-test',${JSON.stringify(message)},'prepared')`
    }),
  )
})

afterAll(async () => {
  await started.stop()
  await removeDatabase(databasePath)
})

const wait = async (token: string) => {
  const child = Bun.spawn(["bash", "scripts/wait-mailbox.sh", "mailbox-test", "2"], {
    env: {
      ...process.env,
      WORKFLOWD_MCP_URL: `http://127.0.0.1:${started.port}/mcp`,
      WORKFLOWD_MCP_TOKEN: token,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("prints the first terminal mailbox message from the real MCP server", async () => {
  const result = await wait("integration-token")
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(message)
})

test("rejects an invalid MCP bearer token", async () => {
  const result = await wait("wrong-token")
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("unauthorized")
  expect(result.stdout).toBe("")
})
