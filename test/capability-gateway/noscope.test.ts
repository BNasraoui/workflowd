import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { mintCapability } from "../../src/capability-gateway/noscope"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { capabilityProvider } from "../../src/capability-gateway/noscope-provider"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { runCapabilityMint, writeNoscopeProvider } from "./fixture"

test("provider command boundary refuses invalid grants", () => {
  for (const args of [[], ["run", "0"], ["run", "3601"], ["run", "extra", "60"], ["other", "60"]])
    expect(() => capabilityProvider(args)).toThrow("capability provider refused")
  const run = capabilityProvider(["run", "60"])
  expect(run.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
})

test("real noscope mints fresh bounded run credentials through the installed provider contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-noscope-"))
  try {
    await writeNoscopeProvider(root, "run-capability", runCapabilityMint)
    const config = { binary: fixtureExecutable("noscope"), configHome: root }
    const first = await mintCapability(
      config,
      "run-capability",
      "run",
      60,
      new AbortController().signal,
    )
    const second = await mintCapability(
      config,
      "run-capability",
      "run",
      60,
      new AbortController().signal,
    )
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.token).not.toBe(first.token)
    expect(first.expiresAt).toBeGreaterThan(Date.now())
    expect(first.expiresAt).toBeLessThanOrEqual(Date.now() + 60000)
    await expect(
      mintCapability(config, "run-capability", "run", 0, new AbortController().signal),
    ).rejects.toThrow("capability mint refused")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("S1/R1: aborting noscope terminates its blocked provider adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "noscope-cancel-"))
  const entered = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<boolean>()
  const sockets = new Set<Socket>()
  const socketPath = join(root, "host.sock")
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("data", () => entered.resolve())
    socket.on("error", () => {})
    socket.once("close", () => {
      sockets.delete(socket)
      closed.resolve(true)
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    await writeNoscopeProvider(root, "provider-access", [
      process.execPath,
      resolve("test/capability-gateway/blocking-provider.mjs"),
      socketPath,
      "{ttl}",
    ])
    const abort = new AbortController()
    const pending = mintCapability(
      { binary: fixtureExecutable("noscope"), configHome: root },
      "provider-access",
      "claude",
      60,
      abort.signal,
    ).then(
      () => "accepted",
      () => "refused",
    )
    await entered.promise
    abort.abort()
    expect(await pending).toBe("refused")
    expect(
      await Promise.race([
        closed.promise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]),
    ).toBe(true)
  } finally {
    for (const socket of sockets) socket.destroy()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
