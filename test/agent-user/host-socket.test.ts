import { expect, spyOn, test } from "bun:test"
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("the host publishes its socket only once the controller can connect", async () => {
  const { serveCredentialHost } = await import("../../src/agent-host/server")
  const filesystem = await import("node:fs/promises")
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
  const original = filesystem.chmod
  // A controller polling for the path (deployed restarts, clients after a restart) must
  // never find it before listen() completes or while it is still root-only.
  const visibleDuringSetup: boolean[] = []
  const setup = spyOn(filesystem, "chmod").mockImplementation(async (target, mode) => {
    visibleDuringSetup.push((await lstat(path).catch(() => null)) !== null)
    await original(target, mode)
  })
  try {
    const host = await serveCredentialHost(path, policy, async () => "", {})
    try {
      expect(visibleDuringSetup).toEqual([false])
      const info = await lstat(path)
      expect(info.isSocket()).toBe(true)
      expect(info.mode & 0o777).toBe(0o600)
      expect([info.uid, info.gid]).toEqual([policy.controllerUid, policy.groupGid])
      await new Promise<void>((resolve, reject) => {
        const client = connect(path, () => {
          client.destroy()
          resolve()
        })
        client.on("error", reject)
      })
    } finally {
      await host.close()
    }
    expect(await readdir(root)).toEqual([])
  } finally {
    setup.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
