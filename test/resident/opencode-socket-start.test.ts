import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { connect, createServer } from "node:net"
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
import { leaveStaleSocket } from "../helpers/stale-socket"

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
