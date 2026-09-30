import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
import { RunPeers, serveRunSocket } from "../../src/worker-identity/peer"

test("socket authenticates two concurrent process trees and denies outsiders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-peers-"))
  const socket = join(directory, "broker.sock")
  const peers = new RunPeers()
  const server = await serveRunSocket(socket, async (request, pid) => {
    const run = new URL(request.url).pathname.slice(1)
    return new Response(null, { status: peers.allows(run, pid) ? 200 : 403 })
  })
  const children = ["a", "b"].map(() =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    const { requestRunSocket } = await import(process.env.TEST_CLIENT);
    await Bun.stdin.text();
    const statuses = [];
    for (const run of ["a", "b"]) statuses.push((await requestRunSocket(process.env.TEST_SOCKET, "/" + run)).status);
    console.log(JSON.stringify(statuses));
  `,
      ],
      {
        env: {
          ...process.env,
          TEST_SOCKET: socket,
          TEST_CLIENT: join(import.meta.dir, "../../src/worker-identity/socket-client.ts"),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  )
  try {
    children.forEach((child, i) => peers.register(i === 0 ? "a" : "b", child.pid))
    children.forEach((child) => {
      void child.stdin.end()
    })
    expect(await new Response(children[0]!.stdout).text()).toBe("[200,403]\n")
    expect(await new Response(children[1]!.stdout).text()).toBe("[403,200]\n")
    expect((await requestRunSocket(socket, "/a")).status).toBe(403)
    await Promise.all(children.map((child) => child.exited))
    expect(peers.allows("a", children[0]!.pid)).toBe(false)
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
