import { expect, test } from "bun:test"
import { runCli } from "../../src/cli"

test("job status and cancel CLI use the run id with authenticated daemon requests", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = []
  const env = { WORKFLOWD_DAEMON_URL: "http://daemon", WORKFLOWD_AGENT_RUN_TOKEN: "fixture" }
  for (const operation of ["status", "cancel"])
    expect(
      await runCli(["job", operation, "agent-run-test"], {
        env,
        log: () => {},
        send: async (url, init) => {
          calls.push({ url: url.pathname, method: init.method })
          expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture")
          return Response.json({ state: "completed" })
        },
      }),
    ).toBe(0)
  expect(calls).toEqual([
    { url: "/workflows/agent-runs/agent-run-test", method: "GET" },
    { url: "/workflows/agent-runs/agent-run-test", method: "DELETE" },
  ])
})

test("job CLI sends family selectors to the configured daemon", async () => {
  let received: unknown
  const call: { credential: string | null } = { credential: null }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      call.credential = request.headers.get("authorization")
      received = await request.json()
      return Response.json({ status: "dispatched", runId: "fixture" }, { status: 202 })
    },
  })
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "job",
        "mint",
        "codex",
        "sol",
        "--repository",
        "workflowd",
        "--prompt",
        "Fix the bug",
        "--thinking",
        "high",
        "--speed",
        "fast",
      ],
      {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          WORKFLOWD_DAEMON_URL: server.url.toString(),
          WORKFLOWD_AGENT_RUN_TOKEN: "fixture-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toEqual({ status: "dispatched", runId: "fixture" })
    expect(received).toEqual({
      host: "mint",
      harness: "codex",
      family: "sol",
      repository: "workflowd",
      prompt: "Fix the bug",
      thinking: { effort: "high" },
      speed: "fast",
    })
    expect(call.credential).toBe("Bearer fixture-secret")
  } finally {
    await server.stop(true)
  }
})

test("models CLI filters discovery and never launches a job", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname + new URL(request.url).search)
      return Response.json({ models: [], sources: [], intents: [] })
    },
  })
  try {
    expect(
      await runCli(["models", "list", "--host", "mint", "--harness", "claude"], {
        env: {
          WORKFLOWD_DAEMON_URL: server.url.toString(),
          WORKFLOWD_AGENT_RUN_TOKEN: "fixture-secret",
        },
        log: () => {},
      }),
    ).toBe(0)
    expect(paths).toEqual(["/models?host=mint&harness=claude"])
  } finally {
    await server.stop(true)
  }
})

test("job CLI accepts host plus family without spelling the native harness", async () => {
  const bodies: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json())
      return Response.json({ status: "dispatched" })
    },
  })
  try {
    expect(
      await runCli(
        ["job", "mint", "opus", "--repository", "workflowd", "--prompt", "Investigate"],
        {
          env: {
            WORKFLOWD_DAEMON_URL: server.url.toString(),
            WORKFLOWD_AGENT_RUN_TOKEN: "fixture-secret",
          },
          log: () => {},
        },
      ),
    ).toBe(0)
    expect(bodies).toEqual([
      { host: "mint", family: "opus", repository: "workflowd", prompt: "Investigate" },
    ])
  } finally {
    await server.stop(true)
  }
})

test("CLI intent preview uses discovery authorization without a repository or task", async () => {
  const requests: Array<{
    url: string
    method: string | undefined
    credential: string | null
    body: unknown
  }> = []
  const output: string[] = []
  const code = await runCli(["job", "mint", "--intent", "research", "--dry-run"], {
    env: {
      WORKFLOWD_DAEMON_URL: "http://daemon",
      WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "discovery-secret",
    },
    send: async (url, init) => {
      const body: unknown = await new Request(url.toString(), init).json()
      requests.push({
        url: url.toString(),
        method: init.method,
        credential: new Headers(init.headers).get("authorization"),
        body,
      })
      return Response.json({ outcome: "resolved", selection: { model: "claude-opus-5-5" } })
    },
    log: (text) => output.push(text),
  })
  expect(code).toBe(0)
  expect(requests).toEqual([
    {
      url: "http://daemon/execution-selections/resolve",
      method: "POST",
      credential: "Bearer discovery-secret",
      body: { host: "mint", intent: "research" },
    },
  ])
  expect(JSON.parse(output[0]!)).toMatchObject({ outcome: "resolved" })
})

test("CLI rejects conflicting target qualifiers before contacting the daemon", async () => {
  let requests = 0
  for (const args of [
    ["job", "mint", "opus", "--family", "sol", "--dry-run"],
    ["job", "mint", "--model", "native", "--version", "5.5", "--dry-run"],
  ]) {
    await expect(
      runCli(args, {
        env: { WORKFLOWD_DAEMON_URL: "http://daemon", WORKFLOWD_AGENT_RUN_TOKEN: "fixture-secret" },
        send: async () => {
          requests++
          return Response.json({})
        },
        log: () => {},
      }),
    ).rejects.toThrow()
  }
  expect(requests).toBe(0)
})
