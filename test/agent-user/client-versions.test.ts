import { expect, test } from "bun:test"
import { probeClientVersions } from "./harness"

test("installed client entrypoints run in the scrubbed credential probe environment", async () => {
  const versions = await probeClientVersions()
  expect(versions.map(({ version }) => version)).toEqual([
    "codex-cli 0.159.1",
    "2.1.296 (Claude Code)",
    "opencode2 v0.0.0-beta-19242",
  ])
  expect(versions.every(({ exitCode }) => exitCode === 0)).toBe(true)
}, 60_000)
