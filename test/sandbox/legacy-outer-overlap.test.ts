import { expect, test } from "bun:test"

test("outer import overlap retains custody through joins and signals", async () => {
  const child = Bun.spawn(["python3", "test/sandbox/fixtures/legacy-outer-overlap.py"], {
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
  expect(error).toContain("Ran 6 tests")
  expect(error).toContain("OK")
}, 120_000)
