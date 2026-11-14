import { expect, test } from "bun:test"

for (const scenario of [
  "matching",
  "unknown-root",
  "wrong-config",
  "wrong-layers",
  "corrupt-archive",
]) {
  test(`legacy immutable image admission: ${scenario}`, async () => {
    const child = Bun.spawn(
      ["python3", "test/sandbox/fixtures/legacy-image-binding.py", scenario],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(error).toBe("")
    expect(status, output).toBe(0)
    expect(JSON.parse(output)).toEqual({ scenario, verified: true })
  })
}
