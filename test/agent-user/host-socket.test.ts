import { expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveCredentialHost } from "../../src/agent-host/server"

async function hostRoot(
  run: (path: string, open: () => ReturnType<typeof serveCredentialHost>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "host-socket-"))
  const path = join(root, "control.sock")
  const login = {
    canonical: join(root, "auth"),
    benLink: join(root, "b"),
    agentLink: join(root, "a"),
  }
  const policy = {
    root,
    ownerUid: process.getuid!(),
    groupGid: process.getgid!(),
    controllerUid: process.getuid!(),
    agentUid: process.getuid!(),
    codex: login,
    claude: login,
    consumerExecutables: [],
  }
  try {
    await run(path, () => serveCredentialHost(path, policy, async () => "", {}))
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function connects(path: string) {
  return new Promise<void>((resolve, reject) => {
    const client = connect(path, () => {
      client.destroy()
      resolve()
    })
    client.on("error", reject)
  })
}

test("the host publishes its socket only once the controller can connect", async () => {
  await hostRoot(async (path, open) => {
    // A controller polling for the path (deployed restarts, clients after a restart) must
    // never find it before listen() completes or while it is still root-only.
    const visibleDuringSetup: Record<"chmod" | "chown", boolean[]> = { chmod: [], chown: [] }
    const visible = async () => (await lstat(path).catch(() => null)) !== null
    const { chmod, chown } = filesystem
    const modeSpy = spyOn(filesystem, "chmod").mockImplementation(async (target, mode) => {
      visibleDuringSetup.chmod.push(await visible())
      await chmod(target, mode)
    })
    const ownerSpy = spyOn(filesystem, "chown").mockImplementation(async (target, uid, gid) => {
      visibleDuringSetup.chown.push(await visible())
      await chown(target, uid, gid)
    })
    try {
      const host = await open()
      try {
        expect(visibleDuringSetup).toEqual({ chmod: [false], chown: [false] })
        const info = await lstat(path)
        expect(info.isSocket()).toBe(true)
        expect(info.mode & 0o777).toBe(0o600)
        expect([info.uid, info.gid]).toEqual([process.getuid!(), process.getgid!()])
        await connects(path)
      } finally {
        await host.close()
      }
    } finally {
      modeSpy.mockRestore()
      ownerSpy.mockRestore()
    }
  })
})

test("a closing host leaves its successor's published socket in place", async () => {
  await hostRoot(async (path, open) => {
    const previous = await open()
    const successor = await open()
    try {
      await previous.close()
      expect((await lstat(path)).isSocket()).toBe(true)
      await connects(path)
    } finally {
      await successor.close()
    }
  })
})

test("a closing host releases itself when its published socket vanishes before unlink", async () => {
  await hostRoot(async (path, open) => {
    const host = await open()
    const { unlink } = filesystem
    // The path disappears between close()'s lstat() and its unlink().
    const removal = spyOn(filesystem, "unlink").mockImplementation(async (target) => {
      await unlink(target)
      await unlink(target)
    })
    try {
      await host.close()
      expect(removal).toHaveBeenCalledWith(path)
    } finally {
      removal.mockRestore()
    }
  })
})
