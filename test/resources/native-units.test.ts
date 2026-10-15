import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { labelNativeTestUnits } from "./native-units"
import { owner } from "./owner"

test("native fixture labels every generated unit through its private launcher", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflowd-test-run-labels-"))
  const binary = join(directory, "real-systemd-run")
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
  try {
    const properties = labelNativeTestUnits(directory, binary)
    expect(properties).toContain(`Environment=WORKFLOWD_TEST_RESOURCE_RUN=${owner()}`)
    expect(properties).toContain(`BindReadOnlyPaths=/usr/bin/systemd-run:${binary}`)
    expect(properties).toContain(
      `BindReadOnlyPaths=${directory}/native-systemd-run:/usr/bin/systemd-run`,
    )
    const unit = `workflowd-native-${crypto.randomUUID()}.service`
    const result = Bun.spawnSync([
      join(directory, "native-systemd-run"),
      `--unit=${unit}`,
      "/bin/true",
    ])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      `--setenv=WORKFLOWD_TEST_RESOURCE_RUN=${owner()}`,
      `--unit=${unit}`,
      "/bin/true",
    ])
    expect(readFileSync(join(directory, "used-system"), "utf8")).toBe("")
    expect(existsSync(join(directory, "workflowd-native-.service.d"))).toBe(false)
    expect(() => labelNativeTestUnits("/not-a-test", binary)).toThrow("guard required")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
