import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { labelNativeTestUnits, removeNativeTestLabels } from "./native-units"
import { owner } from "./owner"
import type { Config } from "./backend"

test("native fixture labels refuse live replacement and remove only their own exact drop-in", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflowd-test-run-labels-"))
  const path = join(directory, "native.service.d/test.conf")
  const config: Config = {
    directory,
    owner: owner(),
    launcher: owner(),
    docker: null,
    systemctl: "/bin/true",
    systemdRun: null,
    env: {},
  }
  try {
    expect(labelNativeTestUnits(directory, path)).toContain(owner())
    expect(() => labelNativeTestUnits(directory, path)).toThrow()
    const stale = owner().split(".")
    stale[6] = "0"
    writeFileSync(path, `[Service]\nEnvironment=WORKFLOWD_TEST_RESOURCE_RUN=${stale.join(".")}\n`)
    expect(labelNativeTestUnits(directory, path)).toContain(owner())
    removeNativeTestLabels({ ...config, owner: "other" }, path)
    expect(readFileSync(path, "utf8")).toContain(owner())
    removeNativeTestLabels(config, path)
    removeNativeTestLabels(config, path)
    expect(() => readFileSync(path)).toThrow()
    expect(() => labelNativeTestUnits("/not-a-test", path)).toThrow("guard required")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
