import { expect, test, spyOn } from "bun:test"
import { Schema } from "effect"
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  mkdir,
  symlink,
  open,
  stat,
  rename,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { makeProviderAccessOwner } from "../../src/agent-host/provider-access"
import { serveCredentialHost } from "../../src/agent-host/server"
import { providerAccessSnapshot } from "../../src/agent-host/client"
import { admitHostCredentials } from "../../src/agent-host/credential-relink"

test("one rotating credential owner persists before publishing and coalesces concurrent snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-provider-owner-"))
  const canonical = join(root, "credential.json")
  const now = Date.now()
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-old",
        refreshToken: "fixture-refresh",
        expiresAt: now - 1,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  let refreshed = 0
  const refresh = async (previous: { refreshToken: string }) => {
    expect(previous.refreshToken).toBe("fixture-refresh")
    refreshed++
    return {
      accessToken: "fixture-new",
      refreshToken: "fixture-rotated",
      expiresAt: now + 3600000,
      scopes: ["user:inference"],
    }
  }
  const owner = makeProviderAccessOwner(
    { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
    refresh,
  )
  try {
    const values = await Promise.all(Array.from({ length: 20 }, () => owner.snapshot()))
    expect(refreshed).toBe(1)
    expect(values.every((value) => value.token === "fixture-new")).toBe(true)
    expect(JSON.parse(await readFile(canonical, "utf8")).claudeAiOauth.refreshToken).toBe(
      "fixture-rotated",
    )
    const reopened = makeProviderAccessOwner(
      { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
      refresh,
    )
    expect((await reopened.snapshot()).token).toBe("fixture-new")
    expect(refreshed).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("credential-host snapshots require exclusive owner configuration and refuse shared native consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-owner-host-"))
  const directory = join(root, "canonical")
  const home = join(root, "home")
  await mkdir(directory, { mode: 0o710 })
  await mkdir(home, { mode: 0o700 })
  const canonical = join(directory, "claude.json")
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 3600000,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  const login = { canonical, benLink: join(home, "ben"), agentLink: join(home, "agent") }
  await symlink(canonical, login.benLink)
  await symlink(canonical, login.agentLink)
  const policy = {
    root: directory,
    ownerUid: process.getuid!(),
    controllerUid: process.getuid!(),
    agentUid: process.getuid!(),
    groupGid: process.getgid!(),
    claude: login,
    codex: login,
    consumerExecutables: [],
    providerAccess: { claude: { clientId: "fixture-public-client" } },
  }
  const owner = makeProviderAccessOwner(
    { canonical, ownerUid: policy.ownerUid, groupGid: policy.groupGid },
    async () => {
      throw new Error("unexpected refresh")
    },
  )
  const socket = join(root, "control.sock")
  const notEnabled = await serveCredentialHost(socket, policy, undefined, {}, owner).then(
    async (server) => {
      await server.close()
      return "admitted"
    },
    () => "refused",
  )
  expect(notEnabled).toBe("refused")
  const server = await serveCredentialHost(
    socket,
    policy,
    undefined,
    { WORKFLOWD_PROVIDER_OWNER_HTTPS: "1" },
    owner,
  )
  try {
    expect((await providerAccessSnapshot(socket)).token).toBe("fixture-access")
    await expect(admitHostCredentials(policy, "claude")).rejects.toThrow(
      "provider_access_owner_required",
    )
    await chmod(canonical, 0o660)
    await expect(providerAccessSnapshot(socket)).rejects.toThrow("provider access unavailable")
    await chmod(canonical, 0o600)
    expect((await providerAccessSnapshot(socket)).token).toBe("fixture-access")
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("uncertain rotation stays fenced across restart; refresh failure never invents access", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-provider-owner-"))
  const canonical = join(root, "credential.json")
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-expired",
        refreshToken: "fixture-refresh",
        expiresAt: 1,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  let attempted = 0
  const refresh = async () => {
    attempted++
    throw new Error("synthetic uncertain provider response")
  }
  try {
    const first = makeProviderAccessOwner(
      { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
      refresh,
    )
    await expect(first.snapshot()).rejects.toThrow("provider custody uncertain")
    const restarted = makeProviderAccessOwner(
      { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
      refresh,
    )
    await expect(restarted.snapshot()).rejects.toThrow("provider custody uncertain")
    expect(attempted).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("R4: owner rejects a canonical GID outside policy before refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-gid-"))
  const canonical = join(root, "credential.json")
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 1,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  let refreshes = 0
  try {
    const config = { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() + 1 }
    const owner = makeProviderAccessOwner(config, async () => {
      refreshes++
      return {
        accessToken: "new",
        refreshToken: "next",
        expiresAt: Date.now() + 3600000,
        scopes: ["user:inference"],
      }
    })
    await expect(owner.snapshot()).rejects.toThrow("provider custody unavailable")
    expect(refreshes).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("R4: canonical replacement during rotation is fenced instead of overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-race-"))
  const canonical = join(root, "credential.json")
  const previous = JSON.stringify({
    claudeAiOauth: {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: 1,
      scopes: ["user:inference"],
    },
  })
  await writeFile(canonical, previous, { mode: 0o600 })
  try {
    const owner = makeProviderAccessOwner(
      { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
      async () => {
        await writeFile(`${canonical}.replacement`, "independent-login", { mode: 0o600 })
        await rename(`${canonical}.replacement`, canonical)
        return {
          accessToken: "new",
          refreshToken: "next",
          expiresAt: Date.now() + 3600000,
          scopes: ["user:inference"],
        }
      },
    )
    await expect(owner.snapshot()).rejects.toThrow("provider custody uncertain")
    expect(await readFile(canonical, "utf8")).toBe("independent-login")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("R4: failed ownership persistence after refresh retains old state and uncertain custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-persistence-"))
  const canonical = join(root, "credential.json")
  const previous = JSON.stringify({
    claudeAiOauth: {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: 1,
      scopes: ["user:inference"],
    },
  })
  await writeFile(canonical, previous, { mode: 0o600 })
  const handle = await open(canonical, "r")
  const prototype: Pick<typeof handle, "chown"> = Object.getPrototypeOf(handle)
  const original = prototype.chown
  await handle.close()
  let changes = 0
  let refreshes = 0
  const fault = spyOn(prototype, "chown").mockImplementation(function (
    this: typeof handle,
    uid,
    gid,
  ) {
    expect([uid, gid]).toEqual([process.getuid!(), process.getgid!()])
    if (++changes === 2) return Promise.reject(new Error("synthetic ownership failure"))
    return original.call(this, uid, gid)
  })
  const config = { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() }
  const refresh = async () => {
    refreshes++
    return {
      accessToken: "new",
      refreshToken: "next",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
    }
  }
  try {
    await expect(makeProviderAccessOwner(config, refresh).snapshot()).rejects.toThrow(
      "synthetic ownership failure",
    )
    fault.mockRestore()
    expect(await readFile(canonical, "utf8")).toBe(previous)
    expect((await stat(canonical)).gid).toBe(config.groupGid)
    await expect(makeProviderAccessOwner(config, refresh).snapshot()).rejects.toThrow(
      "provider custody uncertain",
    )
    expect(refreshes).toBe(1)
  } finally {
    fault.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test("independent owners contend on canonical generation and reread after rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-contention-"))
  const canonical = join(root, "credential.json")
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 1,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let refreshes = 0
  const config = { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() }
  const refresh = async () => {
    refreshes++
    entered.resolve()
    await proceed.promise
    return {
      accessToken: "new",
      refreshToken: "next",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
    }
  }
  const first = makeProviderAccessOwner(config, refresh)
  const second = makeProviderAccessOwner(config, refresh)
  const pending = first.snapshot()
  try {
    await entered.promise
    await expect(second.snapshot()).rejects.toThrow("provider owner busy")
    proceed.resolve()
    expect((await pending).token).toBe("new")
    expect((await second.snapshot()).token).toBe("new")
    expect(refreshes).toBe(1)
  } finally {
    proceed.resolve()
    await pending.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test("confirmed non-rotation cools down without serving access beyond its original expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-expiry-"))
  const canonical = join(root, "credential.json")
  let now = Date.now()
  const expiry = now + 10000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  await writeFile(
    canonical,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: expiry,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  )
  let refreshes = 0
  const owner = makeProviderAccessOwner(
    { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
    async () => {
      refreshes++
      return null
    },
  )
  try {
    expect(await owner.snapshot()).toEqual({ token: "old", expiresAt: expiry })
    expect((await owner.snapshot()).token).toBe("old")
    expect(refreshes).toBe(1)
    now = expiry
    await expect(owner.snapshot()).rejects.toThrow("provider access unavailable")
    expect(refreshes).toBe(1)
    now += 30000
    await expect(owner.snapshot()).rejects.toThrow("provider access unavailable")
    expect(refreshes).toBe(2)
  } finally {
    clock.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test("R10: independent processes share cooldown, expiry, rotation and uncertain custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-process-"))
  const canonical = join(root, "credential.json")
  const count = join(root, "effects")
  const now = Date.now()
  const original = {
    accessToken: "old",
    refreshToken: "refresh",
    expiresAt: now + 10000,
    scopes: ["user:inference"],
  }
  await writeFile(canonical, JSON.stringify({ claudeAiOauth: original }), { mode: 0o600 })
  const children: ReturnType<typeof Bun.spawn>[] = []
  const start = async (mode: string, time = now) => {
    const child = Bun.spawn([process.execPath, resolve("test/agent-host/provider-process.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    child.stdin.write(JSON.stringify({ canonical, count, mode, now: time }) + "\n")
    if (mode !== "hold") await child.stdin.end()
    return child
  }
  const run = async (mode: string, time = now) => {
    const child = await start(mode, time)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    return Schema.decodeUnknownSync(
      Schema.Struct({
        token: Schema.optional(Schema.String),
        expiresAt: Schema.optional(Schema.Number),
        error: Schema.optional(Schema.String),
      }),
    )(JSON.parse(stdout))
  }
  const timeout = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL")
  }, 8000)
  try {
    expect(await run("cooldown")).toEqual({ token: "old", expiresAt: original.expiresAt })
    expect(await run("cooldown")).toEqual({ token: "old", expiresAt: original.expiresAt })
    expect(await readFile(count, "utf8")).toBe("x")
    expect(await run("cooldown", original.expiresAt)).toEqual({
      error: "provider access unavailable",
    })
    expect(await readFile(count, "utf8")).toBe("x")
    const held = await start("hold", now + 30001)
    const reader = held.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("refresh\n")
    expect(await run("rotate", now + 30001)).toEqual({ error: "provider owner busy" })
    held.stdin.write("continue\n")
    await held.stdin.end()
    let result = ""
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      result += new TextDecoder().decode(part.value)
    }
    expect(await held.exited).toBe(0)
    expect(JSON.parse(result).token).toBe("new")
    expect((await run("rotate", now + 30002)).token).toBe("new")
    expect(await readFile(count, "utf8")).toBe("xx")
    // An independently replaced canonical generation must not inherit cooldown.
    await writeFile(
      canonical,
      JSON.stringify({ claudeAiOauth: { ...original, refreshToken: "different" } }),
      { mode: 0o600 },
    )
    expect(await run("cooldown")).toEqual({ token: "old", expiresAt: original.expiresAt })
    await writeFile(
      canonical,
      JSON.stringify({ claudeAiOauth: { ...original, refreshToken: "third" } }),
      { mode: 0o600 },
    )
    expect((await run("uncertain")).error).toBe("provider custody uncertain")
    expect((await run("rotate")).error).toBe("provider custody uncertain")
    expect(await readFile(count, "utf8")).toBe("xxxx")
  } finally {
    clearTimeout(timeout)
    for (const child of children) child.kill("SIGKILL")
    await Promise.all(children.map((child) => child.exited))
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
