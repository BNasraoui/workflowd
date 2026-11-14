import { expect, test } from "bun:test"

test("owned cleanup reconciles late creation without losing failure, identity or budget", async () => {
  const child = Bun.spawn(["python3", "test/sandbox/fixtures/owned-late-create.py"], {
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
  expect(error).toContain("Ran 9 tests")
  expect(error).toContain("OK")
})
