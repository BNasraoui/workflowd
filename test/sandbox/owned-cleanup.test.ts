import { expect, test } from "bun:test"

test("exact-owner controller/reaper cleanup coalesces and rereads; unlocked mutation reproduces the race", async () => {
  const child = Bun.spawn(["python3", "test/sandbox/fixtures/owned-cleanup.py"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(output).toBe("exact-owner concurrent cleanup verified\n")
}, 15000)
