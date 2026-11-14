import { expect, test } from "bun:test"
import { chown, mkdir, mkdtemp, rm, stat, symlink, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeProviderAccessOwner } from "../../src/agent-host/provider-access"
import { credentialLock, inspectCredentialLayout } from "../../src/agent-host/credentials"

// Only filesystem-run.py admits this test: it retains supplementary groups and
// denies every socket syscall before the unchanged repository preload executes.
test("R4: distinct supplementary GID survives rotation and subsequent provider-owner admission", async () => {
  const gid = process.getgroups!().find((value) => value !== process.getgid!())
  if (gid === undefined) throw new Error("distinct supplementary GID fixture required")
  const uid = process.getuid!()
  const root = await mkdtemp(join(tmpdir(), "owner-distinct-gid-"))
  const directory = join(root, "canonical")
  await mkdir(directory, { mode: 0o710 })
  await chown(directory, uid, gid)
  const canonical = join(directory, "claude.json")
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "synthetic-old",
        refreshToken: "synthetic-refresh",
        expiresAt: 1,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  const login = { canonical, benLink: join(root, "controller"), agentLink: join(root, "agent") }
  await symlink(canonical, login.benLink)
  await symlink(canonical, login.agentLink)
  const policy = {
    root: directory,
    ownerUid: uid,
    controllerUid: uid,
    agentUid: uid,
    groupGid: gid,
    claude: login,
    codex: login,
    consumerExecutables: [],
    providerAccess: { claude: { clientId: "synthetic-public" } },
  }
  let rotations = 0
  const owner = () =>
    makeProviderAccessOwner({ canonical, ownerUid: uid, groupGid: gid }, async () => {
      rotations++
      return {
        accessToken: "synthetic-new",
        refreshToken: "synthetic-next",
        expiresAt: Date.now() + 3600000,
        scopes: ["user:inference"],
      }
    })
  const admission = async () => {
    const release = await credentialLock(policy, false)
    try {
      await inspectCredentialLayout(policy, "claude", false, "provider-owner")
      return await owner().snapshot()
    } finally {
      await release()
    }
  }
  try {
    expect((await stat(canonical)).gid).toBe(process.getgid!())
    await expect(admission()).rejects.toThrow("shared_credential_permissions_invalid")
    await expect(owner().snapshot()).rejects.toThrow("provider custody unavailable")
    expect(rotations).toBe(0)
    await chown(canonical, uid, gid)
    const previous = await stat(canonical)
    expect((await admission()).token).toBe("synthetic-new")
    const next = await stat(canonical)
    expect(next.ino).not.toBe(previous.ino)
    expect(next.gid).toBe(gid)
    expect(next.gid).not.toBe(process.getgid!())
    expect(next.uid).toBe(uid)
    expect(next.mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(login.agentLink, "utf8")).claudeAiOauth.refreshToken).toBe(
      "synthetic-next",
    )
    expect((await admission()).token).toBe("synthetic-new")
    expect(rotations).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
