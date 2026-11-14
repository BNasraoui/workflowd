import { lstat } from "node:fs/promises"

/** Binds the path in a child process and kills it with SIGKILL, as systemd does after a slow stop. */
export async function leaveStaleSocket(path: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(process.env.SOCKET, () => console.log("bound"))`,
    ],
    { env: { SOCKET: path }, stdout: "pipe" },
  )
  await child.stdout.getReader().read()
  child.kill("SIGKILL")
  await child.exited
  if (!(await lstat(path)).isSocket()) throw new Error(`${path} was not left as a socket`)
}
