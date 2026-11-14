import { expect, test } from "bun:test"

test("controller death admits readiness only before the original deadline", async () => {
  const child = Bun.spawn(["python3", "test/sandbox/fixtures/owned-readiness.py"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, output, error }).toMatchObject({ code: 0, output: "" })
  expect(error).toContain("Ran 3 tests")
  expect(error).toContain("OK")
})
