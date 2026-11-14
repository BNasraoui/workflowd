import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, chmod } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeProviderAccessOwner, refreshCodexAccess } from "../../src/agent-host/provider-access"
import { serveCredentialHost } from "../../src/agent-host/server"
import { providerAccessSnapshot } from "../../src/agent-host/client"
import { admitHostCredentials } from "../../src/agent-host/credential-relink"

const jwt = (expiresAt: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url")}.synthetic`
test("Codex canonical ChatGPT rotation shares the existing lock, persists native shape and keeps account server-side", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-owner-"))
  const canonical = join(root, "auth.json")
  const token = jwt(Date.now() + 3600000)
  await writeFile(
    canonical,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt(1000),
        refresh_token: "old-refresh",
        id_token: "old-id",
        account_id: "account-fixture",
      },
      last_refresh: "2020-01-01T00:00:00Z",
      preserved: true,
    }),
    { mode: 0o600 },
  )
  let count = 0
  const config = {
    canonical,
    ownerUid: process.getuid!(),
    groupGid: process.getgid!(),
    kind: "codex" as const,
  }
  const refresh = async () => {
    count++
    return {
      accessToken: token,
      refreshToken: "rotated-refresh",
      idToken: "rotated-id",
      accountId: "account-fixture",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
    }
  }
  try {
    const owner = makeProviderAccessOwner(config, refresh)
    const values = await Promise.all(Array.from({ length: 12 }, () => owner.snapshot()))
    expect(count).toBe(1)
    expect(
      values.every(
        (value) =>
          value.token === JSON.stringify({ accessToken: token, accountId: "account-fixture" }),
      ),
    ).toBe(true)
    expect(JSON.parse(await readFile(canonical, "utf8"))).toMatchObject({
      auth_mode: "chatgpt",
      preserved: true,
      tokens: {
        access_token: token,
        refresh_token: "rotated-refresh",
        id_token: "rotated-id",
        account_id: "account-fixture",
      },
    })
    expect((await makeProviderAccessOwner(config, refresh).snapshot()).token).toBe(values[0]!.token)
    expect(count).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("explicit OpenCode key snapshot never falls back to rotating auth or revives an expired key", async () => {
  const root = await mkdtemp(join(tmpdir(), "configured-key-")),
    canonical = join(root, "key.json")
  let refresh = 0
  const owner = makeProviderAccessOwner(
    { canonical, ownerUid: process.getuid!(), groupGid: process.getgid!(), kind: "api-key" },
    async () => {
      refresh++
      throw new Error("must not refresh")
    },
  )
  try {
    await writeFile(
      canonical,
      JSON.stringify({ apiKey: "fixture-key", expiresAt: Date.now() + 3600000 }),
      { mode: 0o600 },
    )
    expect((await owner.snapshot()).token).toBe("fixture-key")
    await writeFile(canonical, JSON.stringify({ apiKey: "fixture-key", expiresAt: 1 }), {
      mode: 0o600,
    })
    await expect(owner.snapshot()).rejects.toThrow()
    expect(refresh).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Codex refresh uses pinned OAuth origin, bounded TLS transport, optional rotation and explicit non-rotation", async () => {
  const previous = {
    accessToken: jwt(1000),
    refreshToken: "fixture-refresh",
    idToken: "fixture-id",
    accountId: "fixture-account",
    expiresAt: 1000,
    scopes: ["user:inference"],
  }
  const expiry = Math.floor((Date.now() + 3600000) / 1000) * 1000
  const access = jwt(expiry)
  let mode = "valid",
    requests = 0
  const refresh = refreshCodexAccess("fixture-client", async (url, input) => {
    requests++
    expect(url).toBe("https://auth.openai.com/oauth/token")
    expect(input).toMatchObject({
      method: "POST",
      redirect: "error",
      tls: { rejectUnauthorized: true },
    })
    expect(input.signal).toBeInstanceOf(AbortSignal)
    if (typeof input.body !== "string") throw new Error("Expected JSON body")
    expect(JSON.parse(input.body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "fixture-refresh",
      client_id: "fixture-client",
    })
    if (mode === "rate") return new Response(null, { status: 429 })
    if (mode === "redirect")
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/escape" } })
    if (mode === "oversize") return new Response("x".repeat(16385))
    return Response.json({
      access_token: access,
      ...(mode === "rotated" ? { refresh_token: "rotated", id_token: "new-id" } : {}),
    })
  })
  expect(await refresh(previous, new AbortController().signal)).toMatchObject({
    ...previous,
    accessToken: access,
    expiresAt: expiry,
  })
  mode = "rotated"
  expect(await refresh(previous, new AbortController().signal)).toMatchObject({
    accountId: previous.accountId,
    refreshToken: "rotated",
    idToken: "new-id",
  })
  mode = "rate"
  expect(await refresh(previous, new AbortController().signal)).toBeNull()
  for (mode of ["redirect", "oversize"])
    await expect(refresh(previous, new AbortController().signal)).rejects.toThrow(
      "provider custody uncertain",
    )
  expect(requests).toBe(5)
})

test("authenticated host selects independent Codex and explicit-key owners and refuses wrong layout without shared DB access", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-owner-host-")),
    directory = join(root, "canonical"),
    home = join(root, "home")
  await mkdir(directory, { mode: 0o710 })
  await mkdir(home, { mode: 0o700 })
  const canonical = join(directory, "codex.json"),
    key = join(directory, "key.json")
  const token = jwt(Date.now() + 3600000)
  await writeFile(
    canonical,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: token,
        refresh_token: "never-refresh",
        id_token: "fixture-id",
        account_id: "account",
      },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    key,
    JSON.stringify({ apiKey: "explicit-key", expiresAt: Date.now() + 3600000 }),
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
    providerAccess: { codex: { clientId: "fixture" }, opencode: { canonical: key } },
  }
  const socket = join(root, "control.sock")
  const host = await serveCredentialHost(socket, policy, undefined, {
    WORKFLOWD_PROVIDER_OWNER_HTTPS: "1",
  })
  try {
    expect(JSON.parse((await providerAccessSnapshot(socket, "codex")).token)).toEqual({
      accessToken: token,
      accountId: "account",
    })
    expect((await providerAccessSnapshot(socket, "opencode")).token).toBe("explicit-key")
    await expect(providerAccessSnapshot(socket, "claude")).rejects.toThrow()
    await expect(admitHostCredentials(policy, "codex")).rejects.toThrow(
      "provider_access_owner_required",
    )
    await chmod(canonical, 0o660)
    await expect(providerAccessSnapshot(socket, "codex")).rejects.toThrow()
    expect((await providerAccessSnapshot(socket, "opencode")).token).toBe("explicit-key")
    await chmod(canonical, 0o600)
    expect(JSON.parse((await providerAccessSnapshot(socket, "codex")).token).accessToken).toBe(
      token,
    )
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
