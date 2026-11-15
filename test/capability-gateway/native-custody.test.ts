import { expect, test } from "bun:test"
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import {
  checkLogin,
  CustodyRefused,
  CustodyUnavailable,
  custodyCommand,
  custodyFailure,
  LoginImportRequired,
  loginFault,
  tokenUrl,
} from "../../src/capability-gateway/custody"
import { importLoginCommand } from "../../src/capability-gateway-server"
import {
  claudeLogin,
  importLogin,
  oauthFixture,
  storedAccess,
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
  storedAccess(await readFile(join(root, "login/claude.json"), "utf8"))

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
}, 30000)

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
    // At least 40 stops, spread over twice the time of a whole import, until both outcomes are seen.
    for (let step = 0; step < 120 && (step < 40 || seen.size < 2); step++) {
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
      await Bun.sleep(((whole * 2 * step) / 40) % (whole * 2))
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
}, 120000)

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
}, 30000)

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
}, 30000)

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
}, 30000)

test("the provider-access template runs custody's access command from the image", async () => {
  const template = await readFile(resolve("deploy/noscope/provider-access.toml"), "utf8")
  const mint = /^mint = "(.*)"$/m.exec(template)?.[1]?.split(" ")
  expect(mint).toEqual([
    "/bin/bun",
    "/app/src/capability-gateway/custody.ts",
    "access",
    "/var/lib/workflowd-gateway/login",
    "{role}",
    "{ttl}",
  ])
})

// The same custody in this process, so that its code counts toward coverage.

const chunks = (text: string) =>
  (async function* () {
    yield Buffer.from(text)
  })()

test("in this process, import-login imports, replaces and refuses as its process does", async () => {
  await withLogin(async (root, _oauth, env) => {
    const login = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now())
    const run = (args: ReadonlyArray<string>, input: string, with_ = env) =>
      importLoginCommand(with_, args, chunks(input))
    expect(await run(["claude"], JSON.stringify(login))).toEqual({
      code: 0,
      output: "imported the claude login\n",
    })
    expect(await run(["claude"], JSON.stringify(login))).toEqual({
      code: 0,
      output: "replaced the claude login\n",
    })
    const refused = async (
      args: ReadonlyArray<string>,
      input: string,
      reason: string,
      with_ = env,
    ) =>
      expect(await run(args, input, with_)).toEqual({
        code: 1,
        error: `import-login refused: ${reason}\n`,
      })
    await refused([], "", "name one provider")
    await refused(["codex"], "", "no provider codex")
    await refused(["claude", "x"], "", "the login is read from standard input only")
    await refused(["claude"], "x".repeat(40000), "the login is longer than 16384 bytes")
    await refused(["claude"], "[]", "the login does not parse")
    await refused(
      ["claude"],
      JSON.stringify({ claudeAiOauth: { ...login.claudeAiOauth, scopes: [] } }),
      "the login does not hold the scope user:inference",
    )
    const config = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      JSON.parse(env.WORKFLOWD_CAPABILITY_GATEWAY ?? "{}"),
    )
    await refused(["claude"], JSON.stringify(login), "the gateway's configuration names no login", {
      ...env,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...config, login: undefined }),
    })
    await refused(["claude"], JSON.stringify(login), "the login was not stored", {
      ...env,
      WORKFLOWD_CAPABILITY_GATEWAY: "{",
    })
    await chmod(join(root, "login"), 0o755)
    await refused(
      ["claude"],
      JSON.stringify(login),
      `custody refused ${join(root, "login")}: mode 0755, custody requires 0700`,
    )
  })
})

test("in this process, custody renews, refuses, waits out a busy server and fences a stopped renewal", async () => {
  await withLogin(async (root, oauth, env) => {
    const directory = join(root, "login")
    const expired = () =>
      claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    const load = async (login: object) =>
      expect((await importLoginCommand(env, ["claude"], chunks(JSON.stringify(login)))).code).toBe(
        0,
      )
    const command = (url = oauth.url) =>
      custodyCommand(["access", directory, "--token-url", url, "claude", "60"])

    // No login yet.
    await expect(command()).rejects.toThrow(`custody refused ${directory}: no login imported`)
    expect(await loginFault(directory, "claude")).toBeUndefined()
    await mkdir(directory, { mode: 0o700 })
    await expect(command()).rejects.toThrow(
      `custody refused ${join(directory, "claude.json")}: no login imported`,
    )

    // Renewed once; the answer of the command lives at most its ttl.
    await load(expired())
    const renewed = await command()
    expect(renewed.token).toBe(oauth.next().access)
    expect(Date.parse(renewed.expires_at)).toBeLessThanOrEqual(Date.now() + 60000)
    expect((await command()).token).toBe(oauth.next().access)
    expect(oauth.requests()).toHaveLength(1)

    // A busy server leaves the refresh value as it was; the next call asks again.
    await load(expired())
    oauth.mode("busy")
    await expect(command()).rejects.toThrow("the OAuth server of claude answered 503")
    oauth.mode("renew")
    expect((await command()).token).toBe(oauth.next().access)
    expect(oauth.requests()).toHaveLength(3)

    // An answer that does not parse may hide a renewal: a new import is required.
    await load(expired())
    oauth.mode("garbled")
    await expect(command()).rejects.toThrow(LoginImportRequired)
    await expect(command()).rejects.toThrow(
      "the claude login needs a new import: a renewal stopped before its answer was stored",
    )
    expect(oauth.requests()).toHaveLength(4)

    // A refusal is final until a new import.
    await load(expired())
    oauth.mode("refuse")
    await expect(command()).rejects.toThrow("the OAuth server refused its renewal")
    await expect(command()).rejects.toThrow("the OAuth server refused its renewal")
    expect(oauth.requests()).toHaveLength(5)
    expect(await loginFault(directory, "claude")).toBe(
      "custody: the claude login needs a new import: the OAuth server refused its renewal",
    )

    // A renewal that a stopped process left behind is not sent again.
    await load(expired())
    await writeFile(join(directory, "claude.state"), JSON.stringify({ state: "renewing" }), {
      mode: 0o600,
    })
    expect(await loginFault(directory, "claude")).toBeUndefined()
    await expect(command()).rejects.toThrow("a renewal stopped before its answer was stored")
    expect(oauth.requests()).toHaveLength(5)

    // No server on the port: nothing was sent, so the next call asks again.
    await load(expired())
    const closed = oauthFixture()
    const url = closed.url
    await closed.stop()
    await expect(command(url)).rejects.toThrow("the OAuth server of claude is not reachable")
    oauth.mode("renew")
    expect((await command()).token).toBe(oauth.next().access)

    // The faults of a path, by path and fault.
    await chmod(join(directory, "claude.json"), 0o640)
    expect(await loginFault(directory, "claude")).toBe(
      `custody refused ${join(directory, "claude.json")}: mode 0640, custody requires 0600`,
    )
    await expect(checkLogin(directory, "claude")).rejects.toThrow(CustodyRefused)
    await chmod(join(directory, "claude.json"), 0o600)
    await link(join(directory, "claude.json"), join(root, "second-link"))
    await expect(command()).rejects.toThrow("2 links, custody requires 1")
    await rm(join(root, "second-link"))
    await rename(join(directory, "claude.json"), join(root, "moved.json"))
    await symlink(join(root, "moved.json"), join(directory, "claude.json"))
    await expect(command()).rejects.toThrow(
      `custody refused ${join(directory, "claude.json")}: a symbolic link`,
    )
    await rm(join(directory, "claude.json"))
    await mkdir(join(directory, "claude.json"))
    await expect(command()).rejects.toThrow("not a file")
    await rm(join(directory, "claude.json"), { recursive: true })
    await writeFile(join(directory, "claude.json"), "x".repeat(20000), { mode: 0o600 })
    await expect(command()).rejects.toThrow("longer than 16384 bytes")
  })
})

test("in this process, the custody command refuses what its grammar does not hold, and its failure line names no value", async () => {
  await withLogin(async (root, oauth) => {
    const directory = join(root, "login")
    for (const args of [
      ["run", directory, "claude", "60"],
      ["access", "login", "claude", "60"],
      ["access", directory, "codex", "60"],
      ["access", directory, "claude", "0"],
      ["access", directory, "claude", "3601"],
      ["access", directory, "claude", "60", "more"],
      ["access", directory, "--token-url", "http://example.com/token", "claude", "60"],
      ["access", directory, "--token-url", "ftp://127.0.0.1/token", "claude", "60"],
    ])
      await expect(custodyCommand(args)).rejects.toThrow(CustodyRefused)
    expect(tokenUrl("claude")).toBe("https://platform.claude.com/v1/oauth/token")
    expect(tokenUrl("claude", "https://example.com/token")).toBe("https://example.com/token")
    expect(custodyFailure(new CustodyUnavailable("the claude login is busy"))).toBe(
      "custody: the claude login is busy\n",
    )
    expect(custodyFailure(new LoginImportRequired("claude", "unanswered"))).toBe(
      "custody: the claude login needs a new import: its renewal got no answer within 5 seconds\n",
    )
    expect(custodyFailure(new Error(syntheticValue("access")))).toBe("custody: refused\n")
    expect(oauth.requests()).toHaveLength(0)
  })
})
