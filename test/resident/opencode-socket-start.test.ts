import { expect, test } from "bun:test"
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { connect, createConnection, createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { OpenCodeMailboxLive } from "../../src/resident/opencode"
import { WorkflowStoreLive } from "../../src/store"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
import { leaveStaleSocket, serveRunSocketInChild } from "../helpers/socket-holders"

// The daemon composes this layer for WORKFLOWD_OPENCODE_RESIDENT_SOCKET (src/layers.ts).
const startMailbox = (socket: string) =>
  OpenCodeMailboxLive(
    {
      owningHostId: "test",
      providerId: "test-server",
      serverId: "test-server",
      endpointAlias: "fixture",
      endpointIdentity: "fixture://opencode",
      providerVersion: 1,
      socket,
      repositories: [{ repository: "o/r", installationId: 1, workflows: ["CI"] }],
    },
    {
      sessionExists: () => Effect.succeed(true),
      promptSession: () => Effect.void,
      setSessionEnvironment: () => Effect.void,
    },
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        KernelEventStoreLive,
        AgentRunStoreLive,
        KernelSessionStoreLive,
        Layer.effect(CiService, makeCiStore),
      ).pipe(
        Layer.provideMerge(WorkflowStoreLive),
        Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  )

const withStateDirectory = async (body: (sockets: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-socket-start-"))
  try {
    await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "started"

const answer = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const client = connect(path)
    let data = ""
    client.on("data", (chunk) => (data += chunk.toString("utf8")))
    client.on("end", () => resolve(data))
    client.on("error", reject)
  })

test("daemon start replaces a socket file that a killed daemon left without a listener", async () => {
  await withStateDirectory(async (directory) => {
    const socket = join(directory, "resident-opencode.sock")
    await leaveStaleSocket(socket)
    const status = await Effect.runPromise(
      Effect.tryPromise(() => requestRunSocket(socket, "/unknown")).pipe(
        Effect.map((response) => response.status),
        Effect.provide(startMailbox(socket)),
      ),
    )
    expect(status).toBe(404)
  })
})

test("daemon start refuses a socket path that a live listener holds and leaves it serving", async () => {
  await withStateDirectory(async (directory) => {
    const socket = join(directory, "resident-opencode.sock")
    const holder = createServer((client) => client.end("alive\n"))
    await new Promise<void>((resolve) => holder.listen(socket, resolve))
    try {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(startMailbox(socket))),
      )
      expect(failureText(exit)).toContain(`${socket} is held by a live process`)
      expect(await answer(socket)).toBe("alive\n")
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
  })
})

test("daemon start refuses a regular file at its socket path and keeps the file", async () => {
  await withStateDirectory(async (directory) => {
    const socket = join(directory, "resident-opencode.sock")
    await writeFile(socket, "not a socket")
    const exit = await Effect.runPromiseExit(Effect.void.pipe(Effect.provide(startMailbox(socket))))
    expect(failureText(exit)).toContain(`${socket} exists and is not a socket`)
    expect(await readFile(socket, "utf8")).toBe("not a socket")
  })
})

const startStatus = (socket: string) =>
  Effect.runPromise(
    Effect.tryPromise(() => requestRunSocket(socket, "/unknown")).pipe(
      Effect.map((response) => response.status),
      Effect.provide(startMailbox(socket)),
    ),
  )

/** Opens connects that nobody accepts until the kernel refuses one: the accept queue is full. */
const fillAcceptQueue = async (path: string) => {
  const queued: Socket[] = []
  for (let attempt = 0; attempt < 4096; attempt++) {
    const client = createConnection(path)
    queued.push(client)
    const connected = await new Promise<boolean>((resolve) => {
      client.once("connect", () => resolve(true))
      client.once("error", () => resolve(false))
    })
    if (!connected) return queued
  }
  throw new Error(`${path} took 4096 connects and its queue never filled`)
}

/** The resumed daemon first accepts the queued connects; until then a new connect is refused. */
const statusOnceDrained = async (path: string) => {
  for (let attempt = 1; ; attempt++) {
    const response = await requestRunSocket(path, "/unknown").catch((error: unknown) => {
      if (attempt === 100) throw error
      return undefined
    })
    if (response !== undefined) return response.status
    await Bun.sleep(50)
  }
}

test("daemon start is refused while a daemon process serves the path and starts after a SIGKILL of it", async () => {
  await withStateDirectory(async (directory) => {
    const socket = join(directory, "resident-opencode.sock")
    const first = await serveRunSocketInChild(socket)
    try {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(startMailbox(socket))),
      )
      expect(failureText(exit)).toContain(
        `${socket} is locked by a live process; refusing to bind it`,
      )
      expect((await requestRunSocket(socket, "/unknown")).status).toBe(404)
    } finally {
      first.kill("SIGKILL")
      await first.exited
    }
    expect((await lstat(socket)).isSocket()).toBe(true)
    expect((await lstat(`${socket}.lock`)).isFile()).toBe(true)
    expect(await startStatus(socket)).toBe(404)
  })
})

test("daemon start keeps the socket of a live daemon that accepts nothing and has a full queue", async () => {
  await withStateDirectory(async (directory) => {
    const socket = join(directory, "resident-opencode.sock")
    const first = await serveRunSocketInChild(socket)
    const inode = (await lstat(socket)).ino
    let queued: Socket[] = []
    try {
      first.kill("SIGSTOP")
      queued = await fillAcceptQueue(socket)
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(startMailbox(socket))),
      )
      expect(failureText(exit)).toContain(
        `${socket} is locked by a live process; refusing to bind it`,
      )
      expect((await lstat(socket)).ino).toBe(inode)
      for (const client of queued) client.destroy()
      first.kill("SIGCONT")
      expect(await statusOnceDrained(socket)).toBe(404)
    } finally {
      for (const client of queued) client.destroy()
      first.kill("SIGKILL")
      await first.exited
    }
  })
})
