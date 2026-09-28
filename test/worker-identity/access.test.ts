import { expect, test } from "bun:test"
import { workerCapability, authorizeWorker } from "../../src/worker-identity/access"
test("worker capabilities are bound to run, live custody and expiry", () => {
  const cap = workerCapability("root-secret", "run1")
  const run = { state: "verified", createdAt: new Date(1000) }
  expect(authorizeWorker("root-secret", "run1", cap, run, 2000)).toBe(true)
  expect(authorizeWorker("root-secret", "run2", cap, run, 2000)).toBe(false)
  expect(authorizeWorker("root-secret", "run1", cap, { ...run, state: "completed" }, 2000)).toBe(
    false,
  )
  expect(authorizeWorker("root-secret", "run1", cap, run, 86401001)).toBe(false)
  expect(authorizeWorker("root-secret", "run1", cap, null, 2000)).toBe(false)
})
