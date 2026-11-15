import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import {
  claudeLogin,
  importLogin,
  oauthFixture,
  syntheticValue,
  type OAuthFixture,
} from "./gateway-process"

/**
 * The custody command as noscope runs it for the provider `provider-access`, several at once and
 * stopped at chosen points, against a fixture OAuth server. Logins are synthetic.
 */

const Provided = Schema.Struct({
  token: Schema.NonEmptyString,
  token_id: Schema.NonEmptyString,
  expires_at: Schema.String,
})

async function withLogin(
  body: (root: string, oauth: OAuthFixture, env: Record<string, string>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "wfd-custody-"))
  const oauth = oauthFixture()
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
      nodeBinary: "/usr/bin/node",
      noscope: { binary: "/usr/bin/noscope", configHome: root },
      storePath: join(root, "gateway.db"),
      controlSocket: join(root, "control/gateway.sock"),
      daemon: { uid: process.getuid!(), gid: process.getgid!() },
      providerId: "anthropic",
      credentialRole: "claude",
      maxStreams: 1,
      maxStreamsPerRun: 1,
      listen: { host: "127.0.0.1", port: 0 },
      login: { directory: join(root, "login") },
    }),
  }
  try {
    await body(root, oauth, env)
  } finally {
    await oauth.stop()
    await rm(root, { recursive: true, force: true })
  }
}

const access = (root: string, oauth: OAuthFixture) =>
  Bun.spawn(
    [
      process.execPath,
      resolve("src/capability-gateway/custody.ts"),
      "access",
      join(root, "login"),
      "--token-url",
      oauth.url,
      "claude",
      "3600",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, stdout: "pipe", stderr: "pipe" },
  )
const finished = async (child: ReturnType<typeof access>) => {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}
const stored = async (root: string) =>
  JSON.parse(await readFile(join(root, "login/claude.json"), "utf8")).claudeAiOauth.accessToken

test("custody processes at one time send one request to the OAuth server, and each gives the new value", async () => {
  await withLogin(async (root, oauth, env) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() + 10000)
    expect((await importLogin(env, JSON.stringify(old))).code).toBe(0)
    const results = await Promise.all([1, 2, 3, 4].map(() => finished(access(root, oauth))))
    expect(oauth.requests()).toHaveLength(1)
    for (const result of results) {
      expect(result.code).toBe(0)
      const provided = Schema.decodeUnknownSync(Schema.fromJsonString(Provided))(result.stdout)
      expect(provided.token).toBe(oauth.next().access)
      expect(Date.parse(provided.expires_at)).toBeGreaterThan(Date.now() + 3500000)
    }
    expect(await stored(root)).toBe(oauth.next().access)
  })
})

test("a stop of import-login at any point of its write leaves the old login or the new one", async () => {
  await withLogin(async (root, oauth, env) => {
    const old = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    // The stops spread over the time of a whole import.
    const began = performance.now()
    expect((await importLogin(env, JSON.stringify(old))).code).toBe(0)
    const whole = performance.now() - began
    const seen = new Set<string>()
    for (let step = 0; step < 40; step++) {
      const next = claudeLogin(
        syntheticValue("access"),
        syntheticValue("refresh"),
        Date.now() + 3600000,
      )
      const before = await stored(root)
      const child = Bun.spawn(
        [process.execPath, resolve("src/capability-gateway-server.ts"), "import-login", "claude"],
        { env, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
      )
      child.stdin.write(JSON.stringify(next))
      await child.stdin.end()
      await Bun.sleep((whole * 1.2 * step) / 40)
      child.kill("SIGKILL")
      await child.exited
      const after = await stored(root)
      expect([before, next.claudeAiOauth.accessToken]).toContain(after)
      seen.add(after === before ? "old" : "new")
    }
    expect([...seen].sort()).toEqual(["new", "old"])
    // A stopped write leaves no file that a later write keeps: the next one removes it.
    const last = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    expect((await importLogin(env, JSON.stringify(last))).code).toBe(0)
    expect((await readdir(join(root, "login"))).sort()).toEqual(["claude.json", "claude.lock"])
    expect(oauth.requests()).toHaveLength(0)
  })
}, 30000)

test("a stop after the answer of the OAuth server and before the write keeps the old login and asks for a new import", async () => {
  await withLogin(async (root, oauth, env) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    expect((await importLogin(env, JSON.stringify(old))).code).toBe(0)
    const child = access(root, oauth)
    oauth.mode("cut", () => child.kill("SIGKILL"))
    const stopped = await finished(child)
    expect(stopped.code).not.toBe(0)
    expect(stopped.stdout).toBe("")
    expect(oauth.requests()).toHaveLength(1)
    expect(await stored(root)).toBe(old.claudeAiOauth.accessToken)

    // The OAuth server may have taken the old refresh value: it is never sent again.
    oauth.mode("renew")
    const again = await finished(access(root, oauth))
    expect(again).toMatchObject({ code: 1, stdout: "" })
    expect(again.stderr).toBe(
      "custody: the claude login needs a new import: a renewal stopped before its answer was stored\n",
    )
    expect(oauth.requests()).toHaveLength(1)

    // A new import ends that state.
    const fresh = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    expect((await importLogin(env, JSON.stringify(fresh))).code).toBe(0)
    const served = await finished(access(root, oauth))
    expect(served.code).toBe(0)
    expect(JSON.parse(served.stdout).token).toBe(fresh.claudeAiOauth.accessToken)
    expect(oauth.requests()).toHaveLength(1)
  })
})

test("an OAuth server that refuses the connection is asked again on the next call", async () => {
  await withLogin(async (root, oauth, env) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    expect((await importLogin(env, JSON.stringify(old))).code).toBe(0)
    const closed = oauthFixture()
    const url = closed.url
    await closed.stop()
    const refused = await finished(
      Bun.spawn(
        [
          process.execPath,
          resolve("src/capability-gateway/custody.ts"),
          "access",
          join(root, "login"),
          "--token-url",
          url,
          "claude",
          "3600",
        ],
        { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
      ),
    )
    expect(refused).toMatchObject({ code: 1, stdout: "" })
    expect(refused.stderr).toBe("custody: the OAuth server of claude is not reachable\n")
    const renewed = await finished(access(root, oauth))
    expect(renewed.code).toBe(0)
    expect(JSON.parse(renewed.stdout).token).toBe(oauth.next().access)
    expect(oauth.requests()).toHaveLength(1)
  })
})

test("the custody command refuses a token URL that is plain HTTP off loopback, and a provider it does not hold", async () => {
  await withLogin(async (root, oauth, env) => {
    const login = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() - 1000,
    )
    expect((await importLogin(env, JSON.stringify(login))).code).toBe(0)
    const run = (args: ReadonlyArray<string>) =>
      finished(
        Bun.spawn([process.execPath, resolve("src/capability-gateway/custody.ts"), ...args], {
          env: { PATH: "/usr/bin:/bin" },
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
    const directory = join(root, "login")
    expect(
      await run(["access", directory, "--token-url", "http://example.com/token", "claude", "60"]),
    ).toEqual({ code: 1, stdout: "", stderr: "custody: refused\n" })
    expect(await run(["access", directory, "codex", "60"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "custody: refused\n",
    })
    expect(oauth.requests()).toHaveLength(0)
  })
})
