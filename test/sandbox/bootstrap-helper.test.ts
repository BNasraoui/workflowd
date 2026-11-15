import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { connect } from "node:net"
import { serveBootstrap, takeJobIdentity } from "../../deploy/sandbox/bootstrap-helper.mjs"
import { join } from "node:path"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("bootstrap proves once before activation and keeps proof off public output", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-bootstrap-"))
  let activated = false
  let issued = 0
  const server = await serveBootstrap({
    directory: root,
    identity: { peerId: "fixture-peer", agentImage: "fixture-image", workflowSha: "fixture-sha" },
    issue: async (audience) => {
      issued++
      expect(audience).toBe("workflowd:fixture")
      return "fixture-signed-token"
    },
    activate: async () => {
      activated = true
    },
    timeoutMs: 1000,
  })
  const socket = connect(`${root}/bootstrap.sock`)
  try {
    socket.write(JSON.stringify({ audience: "workflowd:fixture", peerId: "fixture-peer" }) + "\n")
    const proof = await new Promise<string>((resolve) =>
      socket.once("data", (bytes) => resolve(bytes.toString())),
    )
    expect(JSON.parse(proof).token).toBe("fixture-signed-token")
    expect(activated).toBe(false)
    socket.end(
      JSON.stringify({
        mode: "actions-native",
        token: "a".repeat(43),
        expiresAt: Date.now() + 10000,
        renewAt: Date.now() + 5000,
        deadline: Date.now() + 20000,
      }) + "\n",
    )
    await server.completed
    expect(activated).toBe(true)
    expect(issued).toBe(1)
  } finally {
    socket.destroy()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("helper timeout cannot activate late proof work", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-bootstrap-timeout-"))
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<string>()
  let activated = 0
  const server = await serveBootstrap({
    directory: root,
    identity: { peerId: "fixture", agentImage: "fixture", workflowSha: "fixture" },
    issue: async () => {
      entered.resolve()
      return await proceed.promise
    },
    activate: async () => {
      activated++
    },
    timeoutMs: 40,
  })
  const completed = server.completed.catch(() => "refused")
  const socket = connect(`${root}/bootstrap.sock`)
  socket.on("error", () => {})
  try {
    socket.write(JSON.stringify({ audience: "workflowd:fixture", peerId: "fixture" }) + "\n")
    await entered.promise
    // Queue a grant while issue is blocked, then let the helper deadline expire.
    socket.write(JSON.stringify({ mode: "remote-tools" }) + "\n")
    expect(await completed).toBe("refused")
    proceed.resolve("fixture-token")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(activated).toBe(0)
  } finally {
    proceed.resolve("fixture-token")
    socket.destroy()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("capability job fixture fails visibly when its socket is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-capability-job-"))
  try {
    const child = Bun.spawn(
      [fixtureExecutable("node"), "test/sandbox/fixtures/capability-job.mjs", "attach", root],
      {
        env: {
          PATH: "/usr/bin:/bin",
          SSH_ORIGINAL_COMMAND: "exec /usr/local/bin/runner-control bootstrap",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toContain("capability fixture connect failed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("OIDC authority is removed before launch, consumed once, and refuses hostile origins", async () => {
  for (const origin of [
    "https://fixture.actions.githubusercontent.com/id",
    "http://fixture.actions.githubusercontent.com/id",
    "https://attacker.invalid/id",
    "https://user@fixture.actions.githubusercontent.com/id",
  ]) {
    const environment: Record<string, string | undefined> = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc",
      ACTIONS_ID_TOKEN_REQUEST_URL: origin,
    }
    let requests = 0
    const issue = takeJobIdentity(environment, async (url, init) => {
      requests++
      expect(url.searchParams.get("audience")).toBe("workflowd:fixture")
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-oidc")
      expect(init.redirect).toBe("error")
      return Response.json({ value: "fixture-signed" })
    })
    expect(environment).toEqual({})
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith("ACTIONS_ID_TOKEN_REQUEST_"))))',
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    )
    expect(await new Response(child.stdout).text()).toBe("[]")
    expect(await child.exited).toBe(0)
    const result = await issue("workflowd:fixture", new AbortController().signal).catch(
      () => "refused",
    )
    expect(result).toBe(
      origin === "https://fixture.actions.githubusercontent.com/id" ? "fixture-signed" : "refused",
    )
    await expect(issue("workflowd:fixture", new AbortController().signal)).rejects.toThrow()
    expect(requests).toBe(origin === "https://fixture.actions.githubusercontent.com/id" ? 1 : 0)
  }
})
