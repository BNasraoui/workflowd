import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { mintCapability } from "../../src/capability-gateway/noscope"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { capabilityProvider } from "../../src/capability-gateway/noscope-provider"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("provider command boundary refuses invalid grants and caps owner access to its actual expiry", async () => {
  for (const args of [
    [],
    ["run", "0"],
    ["run", "3601"],
    ["run", "extra", "60"],
    ["other", "60"],
    ["access", "relative", "claude", "60"],
    ["access", "/fixture", "other", "60"],
  ])
    await expect(capabilityProvider(args)).rejects.toThrow("capability provider refused")
  const run = await capabilityProvider(["run", "60"])
  expect(run.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const root = await mkdtemp(join(tmpdir(), "provider-boundary-"))
  const socket = join(root, "owner.sock")
  const expiresAt = Date.now() + 10000
  const server = createServer((client) =>
    client.once("data", (bytes) => {
      expect(JSON.parse(bytes.toString())).toEqual({
        operation: "providerAccess",
        provider: "claude",
      })
      client.end(JSON.stringify({ admitted: true, token: "fixture-access", expiresAt }) + "\n")
    }),
  )
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const access = await capabilityProvider(["access", socket, "claude", "60"])
    expect(access.token).toBe("fixture-access")
    expect(Date.parse(access.expires_at)).toBe(expiresAt)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test("real noscope mints fresh bounded run credentials through the installed provider contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-noscope-"))
  try {
    await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(root, "noscope/providers/run-capability.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
      { mode: 0o600 },
    )
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
    await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(root, "noscope/providers/provider-access.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} access ${socketPath} claude {ttl}"\n`,
      { mode: 0o600 },
    )
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
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]),
    ).toBe(true)
  } finally {
    for (const socket of sockets) socket.destroy()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 3000)
