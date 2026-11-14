import { expect, test } from "bun:test"

test("private diagnostic logs survive writer termination without accepting replacement files", async () => {
  const child = Bun.spawn(["python3", "test/sandbox/fixtures/owned-diagnostics.py"], {
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
  expect(error).toContain("Ran 1 test")
  expect(error).toContain("OK")
})
