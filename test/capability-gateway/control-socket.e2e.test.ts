import { expect, test } from "bun:test"
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture } from "./gateway-process"
import {
  framed,
  gatewayConfig,
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

test("the gateway answers a caller that is not the daemon before it reads a byte, and ends the connection", async () => {
  const f = await fixture()
  const gateway = await startGateway(f, gatewayConfig(f, process.getuid!() + 1))
  try {
    // The caller sends nothing at all.
    const caller = openConnection(socketOf(f))
    const opened = await caller.opened
    expect(JSON.parse(await caller.closed)).toEqual({ ok: false, error: "caller" })
    expect(performance.now() - opened).toBeLessThan(1500)
  } finally {
    await gateway.stop()
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
