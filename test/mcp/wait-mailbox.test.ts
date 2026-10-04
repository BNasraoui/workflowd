import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { startMcpServer, type StartedMcpServer } from "../../src/mcp-server"
import { removeDatabase, runKernel } from "../kernel/job-store-harness"

const databasePath = "test-wait-mailbox.db"
const message = {
  run_id: "run-test",
  session_id: "session-test",
  native_session_id: "native-test",
  route: "implement",
  model: "model-test",
  executor: "codex:local",
  status: "completed",
  end_reason: "completed",
  ended_at: "2026-10-04T00:00:00.000Z",
  final_message: "https://gist.github.com/example/questions\nQuestions are ready.",
  final_message_ref: null,
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

const wait = async (
  token: string,
  options: { url?: string; timeout?: string; path?: string; sleepLog?: string } = {},
) => {
  const child = Bun.spawn(
    ["bash", "scripts/wait-mailbox.sh", "mailbox-test", options.timeout ?? "2"],
    {
      env: {
        ...process.env,
        WORKFLOWD_MCP_URL: options.url ?? `http://127.0.0.1:${started.port}/mcp`,
        WORKFLOWD_MCP_TOKEN: token,
        PATH: options.path ?? process.env.PATH,
        SLEEP_LOG: options.sleepLog ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const withProxy = async (
  reply: (request: Request, attempt: number) => Promise<Response>,
  runTest: (url: string) => Promise<void>,
) => {
  let attempts = 0
  const proxy = Bun.serve({ port: 0, fetch: (request) => reply(request, ++attempts) })
  try {
    await runTest(`http://127.0.0.1:${proxy.port}/mcp`)
  } finally {
    await proxy.stop(true)
  }
}

const forward = (request: Request) =>
  fetch(`http://127.0.0.1:${started.port}/mcp`, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // Bun fetch accepts streaming request bodies without a duplex option.
  })

const withSleepLog = async (runTest: (path: string, log: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "wait-mailbox-"))
  const log = join(dir, "sleeps")
  const script = join(dir, "sleep")
  await writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SLEEP_LOG"\n')
  await chmod(script, 0o755)
  try {
    await runTest(`${dir}:${process.env.PATH}`, log)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("prints the flat terminal mailbox message from the real MCP server", async () => {
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

test("retries two transient HTTP failures with increasing backoff before success", async () => {
  await withSleepLog(async (path, log) => {
    await withProxy(
      (request, attempt) =>
        attempt < 3
          ? Promise.resolve(new Response("temporary", { status: 503 }))
          : forward(request),
      async (url) => {
        const result = await wait("integration-token", { url, path, sleepLog: log, timeout: "10" })
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(message)
        expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["1", "2"])
      },
    )
  })
})

test("polls an empty real mailbox response then returns its first message", async () => {
  await withSleepLog(async (path, log) => {
    await withProxy(
      async (request, attempt) => {
        if (attempt === 1) {
          const body = await request.text()
          const empty = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
            method: "POST",
            headers: request.headers,
            body: body.replace('"mailbox-test"', '"empty-mailbox"'),
          })
          return empty
        }
        return forward(request)
      },
      async (url) => {
        const result = await wait("integration-token", { url, path, sleepLog: log, timeout: "60" })
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(message)
        expect((await readFile(log, "utf8")).trim()).toBe("30")
      },
    )
  })
})

test("clamps retry sleep to the remaining timeout", async () => {
  await withSleepLog(async (path, log) => {
    await withProxy(
      async (_request, attempt) => {
        if (attempt >= 3) await Bun.sleep(2500)
        return new Response("temporary", { status: 503 })
      },
      async (url) => {
        const result = await wait("integration-token", { url, path, sleepLog: log, timeout: "5" })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("timed out")
        const sleeps = (await readFile(log, "utf8")).trim().split("\n").map(Number)
        expect(sleeps.slice(0, 2)).toEqual([1, 2])
        expect(sleeps.at(-1)).toBeLessThan(4)
      },
    )
  })
}, 10000)

test("does not retry bad authorization", async () => {
  await withSleepLog(async (path, log) => {
    const result = await wait("wrong-token", { path, sleepLog: log })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("unauthorized")
    expect(await Bun.file(log).exists()).toBe(false)
  })
})
