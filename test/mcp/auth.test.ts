import { expect, test } from "bun:test"
import {
  authorizedForWrites,
  loadAgentRunDaemon,
  loadAgentWaitDaemon,
  loadMcpWriteAuth,
  requireDaemonTokenWithUrl,
} from "../../src/mcp/auth"

test("writes are disabled when no token source is configured", async () => {
  const auth = await loadMcpWriteAuth({})
  expect(auth).toEqual({ mode: "disabled" })
  expect(authorizedForWrites(auth, "Bearer anything")).toBe(false)
})

test("empty-string sources count as unset so drop-ins can disable them", async () => {
  const auth = await loadMcpWriteAuth({ WORKFLOWD_MCP_TOKEN: "", WORKFLOWD_MCP_TOKEN_FILE: "" })
  expect(auth).toEqual({ mode: "disabled" })
})

test("a direct token enables writes for exact bearer matches only", async () => {
  const auth = await loadMcpWriteAuth({ WORKFLOWD_MCP_TOKEN: "secret-token" })
  expect(auth.mode).toBe("enabled")
  expect(authorizedForWrites(auth, "Bearer secret-token")).toBe(true)
  expect(authorizedForWrites(auth, "Bearer wrong-token")).toBe(false)
  expect(authorizedForWrites(auth, "secret-token")).toBe(false)
  expect(authorizedForWrites(auth, null)).toBe(false)
})

test("a token file is read once and trailing newline is stripped", async () => {
  const auth = await loadMcpWriteAuth({ WORKFLOWD_MCP_TOKEN_FILE: "/credentials/mcp-token" }, () =>
    Promise.resolve("file-token\n"),
  )
  expect(auth).toEqual({ mode: "enabled", token: "file-token" })
})

test("configuring both sources is rejected without echoing values", async () => {
  await expect(
    loadMcpWriteAuth({ WORKFLOWD_MCP_TOKEN: "a", WORKFLOWD_MCP_TOKEN_FILE: "/b" }),
  ).rejects.toThrow("at most one")
})

test("an unreadable or empty token file is a startup error", async () => {
  await expect(
    loadMcpWriteAuth({ WORKFLOWD_MCP_TOKEN_FILE: "/missing" }, () =>
      Promise.reject(new Error("ENOENT")),
    ),
  ).rejects.toThrow("Could not read WORKFLOWD_MCP_TOKEN_FILE")
  await expect(
    loadMcpWriteAuth({ WORKFLOWD_MCP_TOKEN_FILE: "/empty" }, () => Promise.resolve("\n")),
  ).rejects.toThrow("must not be empty")
})

const daemonUrl = "http://127.0.0.1:8787"

test("agent waits stay disabled when nothing is configured", async () => {
  expect(await loadAgentWaitDaemon({})).toBeUndefined()
  expect(
    await loadAgentWaitDaemon({
      WORKFLOWD_DAEMON_URL: "",
      WORKFLOWD_AGENT_WAIT_TOKEN: "",
      WORKFLOWD_AGENT_WAIT_TOKEN_FILE: "",
    }),
  ).toBeUndefined()
})

test("a direct agent-wait token is paired with the daemon origin", async () => {
  const daemon = await loadAgentWaitDaemon({
    WORKFLOWD_DAEMON_URL: `${daemonUrl}/ignored/path`,
    WORKFLOWD_AGENT_WAIT_TOKEN: "daemon-token",
  })

  expect(daemon).toEqual({ baseUrl: daemonUrl, token: "daemon-token" })
})

test("an agent-wait token file is read and its trailing newline stripped", async () => {
  const daemon = await loadAgentWaitDaemon(
    {
      WORKFLOWD_DAEMON_URL: daemonUrl,
      WORKFLOWD_AGENT_WAIT_TOKEN_FILE: "/credentials/agent-wait-token",
    },
    () => Promise.resolve("file-token\n"),
  )

  expect(daemon).toEqual({ baseUrl: daemonUrl, token: "file-token" })
})

test("a half-configured agent-wait proxy is a startup error, not a silent disable", async () => {
  await expect(loadAgentWaitDaemon({ WORKFLOWD_AGENT_WAIT_TOKEN: "daemon-token" })).rejects.toThrow(
    "WORKFLOWD_DAEMON_URL is required",
  )
  await expect(
    loadAgentWaitDaemon({
      WORKFLOWD_DAEMON_URL: daemonUrl,
      WORKFLOWD_AGENT_WAIT_TOKEN: "a",
      WORKFLOWD_AGENT_WAIT_TOKEN_FILE: "/credentials/agent-wait-token",
    }),
  ).rejects.toThrow("Set at most one of")
})

test("a daemon URL with no daemon token at all is a startup error", async () => {
  const env = { WORKFLOWD_DAEMON_URL: daemonUrl }
  expect(await loadAgentWaitDaemon(env)).toBeUndefined()
  expect(await loadAgentRunDaemon(env)).toBeUndefined()
  expect(() => requireDaemonTokenWithUrl(env, [undefined, undefined])).toThrow(
    "Set an agent-wait or agent-run daemon token",
  )
  expect(() =>
    requireDaemonTokenWithUrl(env, [undefined, { baseUrl: daemonUrl, token: "t" }]),
  ).not.toThrow()
})

test("the agent-run daemon binding mirrors the agent-wait pattern", async () => {
  expect(await loadAgentRunDaemon({})).toBeUndefined()
  await expect(loadAgentRunDaemon({ WORKFLOWD_AGENT_RUN_TOKEN: "run-token" })).rejects.toThrow(
    "WORKFLOWD_DAEMON_URL is required",
  )
  const daemon = await loadAgentRunDaemon(
    {
      WORKFLOWD_DAEMON_URL: `${daemonUrl}/ignored`,
      WORKFLOWD_AGENT_RUN_TOKEN_FILE: "/credentials/agent-run-token",
    },
    () => Promise.resolve("run-file-token\n"),
  )
  expect(daemon).toEqual({ baseUrl: daemonUrl, token: "run-file-token" })
  await expect(
    loadAgentRunDaemon({
      WORKFLOWD_DAEMON_URL: daemonUrl,
      WORKFLOWD_AGENT_RUN_TOKEN: "a",
      WORKFLOWD_AGENT_RUN_TOKEN_FILE: "/b",
    }),
  ).rejects.toThrow("Set at most one of")
})

test("the daemon URL must be an absolute credential-free HTTP(S) URL", async () => {
  for (const url of ["not-a-url", "ftp://example.com", "http://user:pass@example.com"]) {
    await expect(
      loadAgentWaitDaemon({
        WORKFLOWD_DAEMON_URL: url,
        WORKFLOWD_AGENT_WAIT_TOKEN: "daemon-token",
      }),
    ).rejects.toThrow(/WORKFLOWD_DAEMON_URL/)
  }
})

test("an unreadable or empty agent-wait token file is a startup error", async () => {
  await expect(
    loadAgentWaitDaemon(
      {
        WORKFLOWD_DAEMON_URL: daemonUrl,
        WORKFLOWD_AGENT_WAIT_TOKEN_FILE: "/credentials/missing",
      },
      () => Promise.reject(new Error("nope")),
    ),
  ).rejects.toThrow("Could not read WORKFLOWD_AGENT_WAIT_TOKEN_FILE")
  await expect(
    loadAgentWaitDaemon(
      {
        WORKFLOWD_DAEMON_URL: daemonUrl,
        WORKFLOWD_AGENT_WAIT_TOKEN_FILE: "/credentials/empty",
      },
      () => Promise.resolve("\n"),
    ),
  ).rejects.toThrow("must not be empty")
})
