import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Keep lifecycle supervision outside the instrumented test process. Besides
// making exit failures observable, this avoids imposing guard coverage on every
// independently filtered coverage shard.
const candidate = process.env.WORKFLOWD_TEST_RESOURCE_CONFIG
const read = (path: string) => {
  const value: { launcher: string; owner: string } = JSON.parse(readFileSync(path, "utf8"))
  return value
}
const bootstrap =
  candidate &&
  existsSync(candidate) &&
  read(candidate).launcher.split(".")[5] === String(process.ppid)
const resourceFree =
  process.pid === 1 && process.env.PATH?.split(":")[0] === join(import.meta.dir, "forbidden")
if (resourceFree) {
  // The offline migration fixture must be the only process in its namespace.
  // Both resource executables are denial stubs in its initial PATH.
} else if (bootstrap) {
  const deadline = Date.now() + 5000
  while (read(candidate).owner.split(".")[5] !== String(process.pid)) {
    if (Date.now() > deadline) throw new Error("Test resource launcher did not register its child")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
} else {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "launcher.ts"),
      ...readFileSync("/proc/self/cmdline", "utf8").split("\0").slice(1).filter(Boolean),
    ],
    { env: { ...process.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  )
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => child.kill(signal))
  process.exit(await child.exited)
}
