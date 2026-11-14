import { expect, test } from "bun:test"

for (const scenario of [
  "runner-missing",
  "tooling-missing",
  "present",
  "tool-missing",
  "cleanup-failure",
]) {
  test(`owned systemd prerequisite command: ${scenario}`, async () => {
    const child = Bun.spawn(
      ["python3", "test/sandbox/fixtures/owned-systemd-prerequisites.py", scenario],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(error).toBe("")
    expect(status, output).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ scenario, verified: true })
  })
}
