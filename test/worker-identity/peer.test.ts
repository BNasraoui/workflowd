import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
import { RunPeers, serveRunSocket } from "../../src/worker-identity/peer"
import { holdDatagramSocketInChild, leaveStaleSocket } from "../helpers/socket-holders"

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

test("socket UID policy denies a foreign UID even with filesystem access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-peer-policy-"))
  const socket = join(directory, "broker.sock")
  let routed = false
  const server = await serveRunSocket(
    socket,
    async () => {
      routed = true
      return new Response(null, { status: 200 })
    },
    {
      controllerUid: process.getuid!() + 1,
      agentUid: process.getuid!() + 2,
      groupGid: process.getgid!(),
    },
  )
  try {
    expect((await requestRunSocket(socket, "/test")).status).toBe(403)
    expect(routed).toBe(false)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

const refusesAndKeeps = async (
  prepare: (directory: string, socket: string) => Promise<void>,
  message: string,
  kept: (socket: string) => Promise<boolean>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-peer-claim-"))
  const socket = join(directory, "broker.sock")
  try {
    await prepare(directory, socket)
    await expect(serveRunSocket(socket, async () => undefined)).rejects.toThrow(
      `${socket} ${message}`,
    )
    expect(await kept(socket)).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("socket start refuses a directory at its path and keeps it", async () => {
  await refusesAndKeeps(
    (_, socket) => mkdir(socket),
    "exists and is not a socket",
    async (socket) => (await lstat(socket)).isDirectory(),
  )
})

test("socket start refuses a symbolic link to a stale socket and keeps both", async () => {
  await refusesAndKeeps(
    async (directory, socket) => {
      await leaveStaleSocket(join(directory, "target.sock"))
      await symlink(join(directory, "target.sock"), socket)
    },
    "exists and is not a socket",
    async (socket) =>
      (await lstat(socket)).isSymbolicLink() &&
      (await lstat(join(socket, "../target.sock"))).isSocket(),
  )
})

test("socket start keeps a datagram socket whose live owner holds the lock of the path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-peer-claim-"))
  const socket = join(directory, "broker.sock")
  const owner = await holdDatagramSocketInChild(socket)
  try {
    const inode = (await lstat(socket)).ino
    await expect(serveRunSocket(socket, async () => undefined)).rejects.toThrow(
      `${socket} is locked by a live process; refusing to bind it`,
    )
    expect((await lstat(socket)).ino).toBe(inode)
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    await rm(directory, { recursive: true, force: true })
  }
})

test("socket start refuses a lock file that others can read and keeps the stale socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-peer-claim-"))
  const socket = join(directory, "broker.sock")
  try {
    await leaveStaleSocket(socket)
    await writeFile(`${socket}.lock`, "", { mode: 0o644 })
    await expect(serveRunSocket(socket, async () => undefined)).rejects.toThrow(
      `${socket}.lock is not a private lock file`,
    )
    expect((await lstat(socket)).isSocket()).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
