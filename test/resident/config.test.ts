import { expect, test } from "bun:test"
import { loadResidentConfig } from "../../src/resident/config"
test("resident dispatch defaults off and needs isolated state and CI", async () => {
  expect(await loadResidentConfig({}, async () => "")).toBeUndefined()
  await expect(
    loadResidentConfig(
      { WORKFLOWD_CODEX_RESIDENT_ENABLED: "true", WORKFLOWD_CODEX_RESIDENT_HOME: "relative" },
      async () => "",
    ),
  ).rejects.toThrow("absolute")
  expect(
    await loadResidentConfig(
      {
        WORKFLOWD_CODEX_RESIDENT_ENABLED: "true",
        WORKFLOWD_CODEX_RESIDENT_HOME: "/scratch/codex",
        WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE: "/secret",
        WORKFLOWD_CI_ENABLED: "true",
      },
      async () => "x".repeat(32),
    ),
  ).toEqual({ home: "/scratch/codex", token: "x".repeat(32) })
})
