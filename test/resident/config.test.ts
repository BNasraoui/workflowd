import { expect, test } from "bun:test"
import { loadResidentConfig } from "../../src/resident/config"
test("resident dispatch defaults off and needs isolated state and CI", async () => {
  expect(await loadResidentConfig({})).toBeUndefined()
  expect(() =>
    loadResidentConfig({
      WORKFLOWD_CODEX_RESIDENT_ENABLED: "true",
      WORKFLOWD_CODEX_RESIDENT_HOME: "relative",
    }),
  ).toThrow("absolute")
  expect(
    await loadResidentConfig({
      WORKFLOWD_CODEX_RESIDENT_ENABLED: "true",
      WORKFLOWD_CODEX_RESIDENT_HOME: "/scratch/codex",
      WORKFLOWD_CODEX_RESIDENT_SOCKET: "/scratch/wait.sock",
      WORKFLOWD_CI_ENABLED: "true",
    }),
  ).toEqual({ home: "/scratch/codex", socket: "/scratch/wait.sock" })
})

test("OpenCode resident inboxes default off and require their own socket and CI", async () => {
  const { loadOpenCodeResidentSocket } = await import("../../src/resident/config")
  expect(loadOpenCodeResidentSocket({})).toBeUndefined()
  expect(() => loadOpenCodeResidentSocket({ WORKFLOWD_OPENCODE_RESIDENT_ENABLED: "yes" })).toThrow()
  expect(() =>
    loadOpenCodeResidentSocket({
      WORKFLOWD_OPENCODE_RESIDENT_ENABLED: "true",
      WORKFLOWD_OPENCODE_RESIDENT_SOCKET: "relative",
      WORKFLOWD_CI_ENABLED: "true",
    }),
  ).toThrow()
  expect(() =>
    loadOpenCodeResidentSocket({
      WORKFLOWD_OPENCODE_RESIDENT_ENABLED: "true",
      WORKFLOWD_OPENCODE_RESIDENT_SOCKET: "/fixture/mailbox.sock",
    }),
  ).toThrow()
  expect(
    loadOpenCodeResidentSocket({
      WORKFLOWD_OPENCODE_RESIDENT_ENABLED: "true",
      WORKFLOWD_OPENCODE_RESIDENT_SOCKET: "/fixture/mailbox.sock",
      WORKFLOWD_CI_ENABLED: "true",
    }),
  ).toBe("/fixture/mailbox.sock")
})
