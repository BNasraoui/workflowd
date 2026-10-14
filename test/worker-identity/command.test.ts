import { expect, test } from "bun:test"
import { workerCommandEnvironment } from "../../src/worker-identity/command-env"
test("command credentials override personal tokens and disable gh auth fallback", () => {
  const env = workerCommandEnvironment(
    {
      GH_TOKEN: "personal",
      GITHUB_TOKEN: "personal",
      GH_HOST: "other",
      GH_ENTERPRISE_TOKEN: "personal",
      HOME: "/home/test",
    },
    "app-token",
  )
  expect(env.GH_TOKEN).toBe("app-token")
  expect(env.GITHUB_TOKEN).toBe("app-token")
  expect(env.GH_HOST).toBe("github.com")
  expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
  expect(env.HOME).toBe("/home/test")
})

test("Git broker commands reject SSH fallback and carry a session capability only in the socket body", async () => {
  const { runWorkerCommand } = await import("../../src/worker-identity/command")
  let requestBody: string | undefined
  let argv: string[] = []
  let environment: Record<string, string | undefined> = {}
  await runWorkerCommand(
    ["--git", "--", "push", "origin", "HEAD"],
    {
      WORKFLOWD_RUN_ID: "run",
      WORKFLOWD_WORKER_GITHUB_SOCKET: "/broker.sock",
      WORKFLOWD_WORKER_SESSION_ID: "session",
      WORKFLOWD_WORKER_CAPABILITY: "a".repeat(64),
      SSH_AUTH_SOCK: "/personal/ssh",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "personal",
      GIT_TRACE_PACKET: "1",
    },
    {
      request: async (_socket, _path, body) => {
        requestBody = body
        return Response.json({ token: "app", expiresAt: Date.now() + 3600000 })
      },
      run: async (args, env) => {
        argv = args
        environment = env
        return 0
      },
    },
  )
  expect(JSON.parse(requestBody!)).toEqual({ sessionId: "session", capability: "a".repeat(64) })
  expect(argv).toContain("protocol.allow=never")
  expect(argv).toContain("protocol.https.allow=always")
  expect(argv.join(" ")).not.toContain("a".repeat(64))
  expect(environment.SSH_AUTH_SOCK).toBeUndefined()
  expect(environment.GIT_CONFIG_COUNT).toBeUndefined()
  expect(environment.GIT_TRACE_PACKET).toBeUndefined()
})

test("agent OpenCode environment keeps its own home and excludes controller config and SSH", async () => {
  const { workerEnvironment } = await import("../../src/resident/environment")
  const env = workerEnvironment({
    WORKFLOWD_AGENT_HOME: "/var/lib/agent",
    WORKFLOWD_AGENT_PATH: "/opt/agent/bin:/usr/bin:/bin",
    HOME: "/home/controller",
    SSH_AUTH_SOCK: "/private/socket",
    GIT_CONFIG_GLOBAL: "/private/gitconfig",
    CLAUDE_CONFIG_DIR: "/private/claude",
    PATH: "/home/controller/bin",
  })
  expect(env.HOME).toBe("/var/lib/agent")
  expect(env.PATH).toBe("/opt/agent/bin:/usr/bin:/bin")
  expect(env.XDG_CONFIG_HOME).toBe("/var/lib/agent/.config")
  expect(env.SSH_AUTH_SOCK).toBeUndefined()
  expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(env.CLAUDE_CONFIG_DIR).toBe("/var/lib/agent/.claude")
})

test("gh arguments survive Bun removing the leading separator", async () => {
  const { runWorkerCommand } = await import("../../src/worker-identity/command")
  let argv: string[] = []
  await runWorkerCommand(
    ["api", "repos/o/r/pulls"],
    { WORKFLOWD_RUN_ID: "run", WORKFLOWD_WORKER_GITHUB_SOCKET: "/broker" },
    {
      request: async () => Response.json({ token: "fixture", expiresAt: Date.now() + 3600000 }),
      run: async (args) => {
        argv = args
        return 0
      },
    },
  )
  expect(argv).toEqual(["gh", "api", "repos/o/r/pulls"])
})
