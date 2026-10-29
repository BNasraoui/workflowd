import { expect, test } from "bun:test"
import { owner, ownerState } from "./owner"

test("run identity distinguishes a live process, PID reuse, boot and foreign hosts", () => {
  const id = owner()
  expect(ownerState(id)).toBe("alive")
  const fields = id.split(".")
  fields[6] = "0"
  expect(ownerState(fields.join("."))).toBe("dead")
  fields[3] = "0".repeat(32)
  expect(ownerState(fields.join("."))).toBe("dead")
  fields[1] = "0".repeat(32)
  expect(ownerState(fields.join("."))).toBe("unknown")
  expect(ownerState("workflowd-sandbox-old")).toBe("unknown")
  expect(ownerState(undefined)).toBe("unknown")
})

test("a dead child is stale even before its PID can be reused", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { owner } from './test/resources/owner'; console.log(owner())`,
    ],
    { stdout: "pipe" },
  )
  const id = (await new Response(child.stdout).text()).trim()
  await child.exited
  expect(ownerState(id)).toBe("dead")
})
