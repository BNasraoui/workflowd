import { expect, test } from "bun:test"
import { authorizedForWrites, loadMcpWriteAuth } from "../../src/mcp/auth"

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
