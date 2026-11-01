import { expect, test } from "bun:test"
import { join } from "node:path"

// Bun is PID 1 of the namespace, as in the administrative coverage step and every
// isolated credential probe. It never reaps an orphan it did not spawn.
async function remainingAfter(mode: "spawn" | "tree", shell: string, timeoutSeconds = 20) {
  const harness = JSON.stringify(join(import.meta.dir, "harness.ts"))
  const program = `
import { readdirSync } from "node:fs"
import { runClientTree } from ${harness}
const command = ["/bin/sh", "-c", ${JSON.stringify(shell)}]
if (${JSON.stringify(mode)} === "tree") {
  await runClientTree(command, { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutSeconds: ${timeoutSeconds} })
} else {
  await Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] }).exited
  await Bun.sleep(500)
}
const others = readdirSync("/proc").filter((entry) => /^\\d+$/.test(entry) && Number(entry) !== process.pid)
console.log(JSON.stringify(others.length))`
  const child = Bun.spawn(
    [
      "unshare",
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "--mount-proc",
      process.execPath,
      "--eval",
      program,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(stderr)
  return Number(JSON.parse(stdout))
}

test("a client's orphaned helper outlives a plain spawn where Bun is namespace PID 1", async () => {
  // An exited orphan stays a zombie forever, and relink counts it as an agent process.
  expect(await remainingAfter("spawn", "/bin/sleep 0.1 & exit 0")).toBe(1)
  expect(await remainingAfter("spawn", "/bin/sleep 30 & exit 0")).toBe(1)
})

test("installed clients leave no process, live or zombie, once their run returns", async () => {
  expect(await remainingAfter("tree", "/bin/sleep 0.1 & exit 0")).toBe(0)
  expect(await remainingAfter("tree", "/bin/sleep 30 & exit 0")).toBe(0)
  // A client that reaches its time limit is killed together with its helpers.
  const started = Date.now()
  expect(await remainingAfter("tree", "/bin/sleep 30 & exec /bin/sleep 30", 1)).toBe(0)
  expect(Date.now() - started).toBeLessThan(15_000)
}, 30_000)
