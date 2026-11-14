import { expect, test } from "bun:test"
import { runnerFixture } from "./harness"
import { engineHostBoundaryFixture } from "./fixtures/engine-host-boundary"

test("synthetic host bridge keeps its MAC while a temporary probe port is attached", async () => {
  const runner = await runnerFixture()
  try {
    const boundary = await engineHostBoundaryFixture(runner)
    const addresses = await boundary.probe()
    await boundary.close()
    const [before, during, after] = addresses.split("\n")
    expect(during).toBe(before)
    expect(after).toBe(before)
  } finally {
    await runner.close()
  }
}, 120000)
