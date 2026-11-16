import { expect, test } from "bun:test"
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { maxControlFrame } from "../../src/capability-control/protocol"
import { fixture } from "./gateway-process"
import {
  framed,
  gatewayConfig,
  halfOpenConnection,
  openConnection,
  rawFrame,
  socketOf,
  startGateway,
} from "./control-socket"

/** The control socket of the gateway process alone: its caller check, its limits and its paths. */

test("the gateway refuses to start when its control directory grants more than the daemon's group", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, "control"), { mode: 0o755 })
    await chmod(join(f.root, "control"), 0o755)
    await expect(startGateway(f)).rejects.toThrow()
  } finally {
    await f.close()
  }
})

test("the gateway holds 16 of the daemon's connections at once, and ends each 10 seconds after it accepted it", async () => {
  const f = await fixture()
  const gateway = await startGateway(f)
  try {
    const socket = socketOf(f)
    const held = Array.from({ length: 16 }, () => openConnection(socket))
    const accepted = await Promise.all(held.map((connection) => connection.opened))
    // The 17th is refused at once.
    expect(JSON.parse(await openConnection(socket).closed)).toEqual({
      ok: false,
      error: "unavailable",
    })
    // One connection sends a cut frame and stops; another keeps sending a byte every 500 ms.
    held[0]!.connection.write(framed(JSON.stringify({ verb: "reconcile" }), 100))
    held[1]!.connection.write(framed("", 100).subarray(0, 4))
    const trickle = setInterval(() => held[1]!.connection.write("x"), 500)
    try {
      const ends = await Promise.all(
        held.map(async (connection) => ({
          answer: await connection.closed,
          at: performance.now(),
        })),
      )
      for (const [index, end] of ends.entries()) {
        expect(end.answer).toBe("closed")
        expect(end.at - accepted[index]!).toBeGreaterThan(9500)
        expect(end.at - accepted[index]!).toBeLessThan(11500)
      }
    } finally {
      clearInterval(trickle)
    }
    // With the 16 gone, the next request is answered.
    expect(
      JSON.parse(
        await rawFrame(socket, framed(JSON.stringify({ verb: "reconcile", body: { live: [] } }))),
      ),
    ).toEqual({ ok: true, value: null })
  } finally {
    await gateway.stop()
    await f.close()
  }
}, 30000)

test("the gateway refuses a control directory whose parent another user could replace an entry of", async () => {
  const f = await fixture()
  try {
    const under = (parent: string) => ({
      ...gatewayConfig(f),
      controlSocket: join(parent, "control", "gateway.sock"),
    })
    for (const [mode, starts] of [
      [0o777, false],
      [0o770, false],
      [0o1777, true],
      [0o755, true],
    ] as const) {
      const parent = join(f.root, `parent-${mode.toString(8)}`)
      await mkdir(parent)
      // coreutils' chmod: it sets the sticky bit on each Bun this suite runs on.
      await Bun.$`chmod ${mode.toString(8)} ${parent}`
      if (starts) await (await startGateway(f, under(parent))).stop()
      else
        await expect(startGateway(f, under(parent))).rejects.toThrow(
          "lets another user replace the control socket directory",
        )
    }
    // A path through a symbolic link is refused, even to a parent that passes.
    await symlink(join(f.root, "parent-755"), join(f.root, "link"))
    await expect(startGateway(f, under(join(f.root, "link")))).rejects.toThrow(
      "must be named by its real path",
    )
  } finally {
    await f.close()
  }
})

test("the gateway refuses to start on a control directory or socket path that is not its own", async () => {
  const f = await fixture()
  try {
    const control = join(f.root, "control")
    const refusal = "control socket directory must be the gateway's"
    // The directory has another group than the daemon's.
    await mkdir(control)
    await chmod(control, 0o710)
    await expect(
      startGateway(f, {
        ...gatewayConfig(f),
        daemon: { uid: process.getuid!(), gid: process.getgid!() + 1 },
      }),
    ).rejects.toThrow(refusal)
    // A symbolic link to a directory that passes, in place of the directory.
    await Bun.$`mv ${control} ${join(f.root, "real")}`
    await symlink(join(f.root, "real"), control)
    await expect(startGateway(f)).rejects.toThrow(refusal)
    // A file in place of the directory.
    await Bun.$`rm ${control}`
    await writeFile(control, "")
    await expect(startGateway(f)).rejects.toThrow(refusal)
    // A file that is not a socket at the socket's path; it stays.
    await Bun.$`rm ${control}`
    await mkdir(control)
    await chmod(control, 0o710)
    await writeFile(socketOf(f), "kept")
    await expect(startGateway(f)).rejects.toThrow("is not a socket")
    expect(await Bun.file(socketOf(f)).text()).toBe("kept")
    // A second gateway on the socket of a live one; the first still answers.
    await Bun.$`rm ${socketOf(f)}`
    const first = await startGateway(f)
    try {
      await expect(startGateway(f)).rejects.toThrow("locked by a live process")
      expect(
        JSON.parse(
          await rawFrame(
            socketOf(f),
            framed(JSON.stringify({ verb: "reconcile", body: { live: [] } })),
          ),
        ),
      ).toEqual({ ok: true, value: null })
    } finally {
      await first.stop()
    }
  } finally {
    await f.close()
  }
})

const reconcileFrame = framed(JSON.stringify({ verb: "reconcile", body: { live: [] } }))

test("the gateway answers a refused caller that sends nothing and ends its side, then reads the caller's request until the caller ends", async () => {
  const f = await fixture()
  const gateway = await startGateway(f, gatewayConfig(f, process.getuid!() + 1))
  try {
    const caller = halfOpenConnection(socketOf(f))
    // The caller has sent nothing when the answer and the end of the gateway's side come.
    expect(JSON.parse(await caller.answer)).toEqual({ ok: false, error: "caller" })
    caller.connection.end(reconcileFrame)
    await caller.closed
    expect(caller.errors).toEqual([])
  } finally {
    await gateway.stop()
    await f.close()
  }
})

test("a refused caller's request of more than one chunk meets no write error, and gets the caller answer", async () => {
  const f = await fixture()
  const gateway = await startGateway(f, gatewayConfig(f, process.getuid!() + 1))
  try {
    const request = framed(Buffer.alloc(maxControlFrame - 1, "x"))
    const caller = halfOpenConnection(socketOf(f))
    await caller.opened
    // One part of the request before the answer, and the rest after it.
    caller.connection.write(request.subarray(0, 4096))
    expect(JSON.parse(await caller.answer)).toEqual({ ok: false, error: "caller" })
    caller.connection.end(request.subarray(4096))
    await caller.closed
    expect(caller.errors).toEqual([])
  } finally {
    await gateway.stop()
    await f.close()
  }
})

test("the gateway closes a refused caller that sends more than one frame's bytes", async () => {
  const f = await fixture()
  const gateway = await startGateway(f, gatewayConfig(f, process.getuid!() + 1))
  try {
    const caller = halfOpenConnection(socketOf(f))
    expect(JSON.parse(await caller.answer)).toEqual({ ok: false, error: "caller" })
    // Twice the bound, more than the socket's buffers hold: the write completes only if the
    // gateway reads it all, and fails if the gateway closes the connection past the bound.
    caller.connection.end(Buffer.alloc(2 * maxControlFrame))
    await caller.closed
    expect(["EPIPE", "ECONNRESET"]).toContain(String(caller.errors[0]))
  } finally {
    await gateway.stop()
    await f.close()
  }
})

test("the gateway holds 16 refused connections at once; the next one is closed with no answer until one ends", async () => {
  const f = await fixture()
  const gateway = await startGateway(f, gatewayConfig(f, process.getuid!() + 1))
  try {
    const held = Array.from({ length: 16 }, () => halfOpenConnection(socketOf(f)))
    for (const caller of held)
      expect(JSON.parse(await caller.answer)).toEqual({ ok: false, error: "caller" })
    const over = halfOpenConnection(socketOf(f))
    expect(await over.answer).toBe("closed")
    // Once one of the 16 ends, a new caller is answered: the gateway frees the place when it
    // reads the end, which the caller does not see, so a caller tries until it is answered.
    held[0]!.connection.end()
    let next = "closed"
    while (next === "closed") next = await halfOpenConnection(socketOf(f)).answer
    expect(JSON.parse(next)).toEqual({ ok: false, error: "caller" })
    for (const caller of held) caller.connection.end()
  } finally {
    await gateway.stop()
    await f.close()
  }
})

/**
 * `serveSocket` in a new user namespace with its own mount namespace, on a socket under a tmpfs
 * at /mnt that the namespace's root owns. `/` is owned by the host's root, which the namespace
 * does not map, so `/` shows the overflow uid. With `nested`, the namespace is made inside a
 * first one, and maps the first one's root: its uid 0 has a mapping.
 */
async function serveInNamespace(nested: boolean) {
  const script = `import { createServer } from "node:net"
import { serveSocket } from ${JSON.stringify(join(import.meta.dir, "../../src/peer-socket.ts"))}
const role = { socket: "control socket", group: "the daemon's group" }
try {
  const close = await serveSocket(createServer(), "/mnt/control/gateway.sock", 0, 0o710, role)
  await close()
  console.log("served")
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error))
}`
  const inner = ["unshare", "--user", "--map-root-user", "--mount", "sh", "-c"]
  const serve = `mount -t tmpfs tmpfs /mnt && cat /proc/self/uid_map >&2 && exec "$0" -e "$1"`
  const command = nested
    ? ["unshare", "--user", "--map-root-user", ...inner, serve, process.execPath, script]
    : [...inner, serve, process.execPath, script]
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [out, map] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  return { result: out.trim(), map: map.trim().split(/\s+/) }
}

test("the overflow uid passes as the owner of / only in a user namespace that does not map uid 0", async () => {
  // The host's uid 0 has no mapping: the namespace cannot tell who owns `/`, and accepts it.
  const unmapped = await serveInNamespace(false)
  expect(unmapped.map[1]).not.toBe("0")
  expect(unmapped.result).toBe("served")
  // The first namespace's uid 0 has a mapping, and does not own `/`.
  const mapped = await serveInNamespace(true)
  expect(mapped.map).toEqual(["0", "0", "1"])
  expect(mapped.result).toBe("/ lets another user replace the control socket directory")
})
