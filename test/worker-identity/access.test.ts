import { expect, test } from "bun:test"
import { authorizeWorker } from "../../src/worker-identity/access"
test("worker capabilities are bound to run, live custody and expiry", () => {
  const run = { state: "verified", createdAt: new Date(1000) }
  expect(authorizeWorker(run, 2000)).toBe(true)
  expect(authorizeWorker({ ...run, state: "completed" }, 2000)).toBe(false)
  expect(authorizeWorker(run, 86401001)).toBe(false)
  expect(authorizeWorker(null, 2000)).toBe(false)
})
