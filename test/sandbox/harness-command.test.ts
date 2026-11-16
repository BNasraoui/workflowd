import { expect, test } from "bun:test"
import { command } from "../../deploy/sandbox/command.mjs"

/**
 * The runner of a harness's child processes (the box's docker calls, the seal's result.py): its
 * standard output on success, and a failure that names its step on each other end.
 */

test("a child's standard output is the answer, with its standard input given", async () => {
  expect(await command("echo", "/bin/cat", [], { input: "sealed\n" })).toBe("sealed\n")
})

test("a child that exits other than 0 fails with its step, its status and its last standard error", async () => {
  await expect(command("seal", "/bin/sh", ["-c", "echo refused >&2; exit 3"])).rejects.toThrow(
    "seal: exit 3: refused",
  )
})

test("a child that outlives its time is killed, and fails with its step and the signal", async () => {
  const started = Date.now()
  await expect(command("pull", "/bin/sleep", ["30"], { timeoutMs: 100 })).rejects.toThrow(
    "pull: exit SIGKILL: ",
  )
  expect(Date.now() - started).toBeLessThan(10000)
})

test("a binary that does not exist fails with its step", async () => {
  await expect(command("box start", "/nonexistent/docker", ["start"])).rejects.toThrow(
    "box start: ",
  )
})
