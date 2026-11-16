import { spawn } from "node:child_process"

/**
 * One read of the directory `path` as a tar archive, as a harness reads its box's stopped
 * workspace: `stream`, and `done`, which fails when tar fails or its read is stopped.
 */
export function directoryArchive(path) {
  const child = spawn("/usr/bin/tar", ["-cf", "-", "-C", path, "."], {
    stdio: ["ignore", "pipe", "ignore"],
  })
  const done = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar: exit ${code ?? "by a signal"}`)),
    )
  })
  return { stream: child.stdout, done }
}
