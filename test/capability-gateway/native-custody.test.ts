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
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { checkLogin, CustodyRefused, loginFault } from "../../src/capability-gateway/custody"
import { custodyCommand } from "../../src/capability-gateway/custody-process"
import { importLoginCommand } from "../../src/capability-gateway-server"
import {
  claudeLogin,
  importLogin,
  oauthFixture,
  sentRefresh,
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
      listen: {
        socket: join(root, "front/gateway.sock"),
        front: { uid: process.getuid!(), gid: process.getgid!() },
        service: "gateway.example.ts.net",
      },
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
      resolve("src/capability-gateway/custody-process.ts"),
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

test("a stop after the answer of the OAuth server and before the write keeps the old login, and the next call sends the same refresh value once more", async () => {
  await withLogin(async (root, oauth, env) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    expect((await importLogin(env, JSON.stringify(old))).code).toBe(0)
    const child = access(root, oauth)
    oauth.mode("cut", { cut: () => child.kill("SIGKILL") })
    const stopped = await finished(child)
    expect(stopped.code).not.toBe(0)
    expect(stopped.stdout).toBe("")
    expect(oauth.requests()).toHaveLength(1)
    expect(await stored(root)).toBe(old.claudeAiOauth.accessToken)

    oauth.mode("renew")
    const again = await finished(access(root, oauth))
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout).token).toBe(oauth.next().access)
    expect(oauth.requests().map(sentRefresh)).toEqual([
      old.claudeAiOauth.refreshToken,
      old.claudeAiOauth.refreshToken,
    ])
    expect(await stored(root)).toBe(oauth.next().access)
    expect((await readdir(join(root, "login"))).sort()).toEqual(["claude.json", "claude.lock"])
  })
}, 30000)

test("an OAuth server that refuses the connection leaves the login as it was, the next run sends nothing before the first wait ends, and a run after it renews", async () => {
  await withLogin(async (root, oauth, env) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    expect((await importLogin(env, JSON.stringify(old))).code).toBe(0)
    const closed = oauthFixture()
    const url = closed.url
    await closed.stop()
    const custody = (to: string) =>
      finished(
        Bun.spawn(
          [
            process.execPath,
            resolve("src/capability-gateway/custody-process.ts"),
            "access",
            join(root, "login"),
            "--token-url",
            to,
            "claude",
            "3600",
          ],
          { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
        ),
      )
    const refused = await custody(url)
    expect(refused).toMatchObject({ code: 1, stdout: "" })
    expect(refused.stderr).toStartWith(
      "custody: the OAuth server of claude gave no answer that custody reads; no request before ",
    )
    expect(await stored(root)).toBe(old.claudeAiOauth.accessToken)
    const waiting = await custody(oauth.url)
    expect(waiting.stderr).toStartWith("custody: the claude login waits to renew until ")
    expect(oauth.requests()).toHaveLength(0)
    // After the wait that custody wrote, on the clock that it reads, the next run renews.
    const { retryAt } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ retryAt: Schema.Number })),
    )(await readFile(join(root, "login", "claude.state"), "utf8"))
    while (Date.now() <= retryAt) await Bun.sleep(retryAt - Date.now() + 1)
    const renewed = await custody(oauth.url)
    expect(renewed.code).toBe(0)
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(Provided))(renewed.stdout).token).toBe(
      oauth.next().access,
    )
    expect(oauth.requests()).toHaveLength(1)
    expect(oauth.requests()[0]!.time).toBeGreaterThanOrEqual(retryAt)
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
        Bun.spawn([process.execPath, resolve("src/capability-gateway/custody-process.ts"), ...args], {
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

test("the provider-access template runs custody's access command from the image, on the login directory of the configuration", async () => {
  const template = await readFile(resolve("deploy/noscope/provider-access.toml"), "utf8")
  const mint = /^mint = "(.*)"$/m.exec(template)?.[1]?.split(" ")
  expect(mint).toEqual([
    "/bin/bun",
    "/app/src/capability-gateway/custody-process.ts",
    "access",
    "LOGIN_DIRECTORY",
    "{role}",
    "{ttl}",
  ])
})

// The command surfaces of custody in this process (`importLoginCommand` of the gateway's entry,
// `custodyCommand` that noscope's provider runs, and `checkLogin` and `loginFault` that the
// gateway calls), so that their code counts toward coverage: a process's run does not.

/** A reader of standard input that holds `text`, and records the limit it was asked for. */
const input =
  (text: string, asked: number[] = []) =>
  async (limit: number) => {
    asked.push(limit)
    return Buffer.from(text).subarray(0, limit)
  }

test("in this process, import-login imports, replaces and refuses as its process does, and reads at most 16385 bytes", async () => {
  await withLogin(async (root, _oauth, env) => {
    const login = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now())
    const asked: number[] = []
    const run = (args: ReadonlyArray<string>, text: string, with_ = env) =>
      importLoginCommand(with_, args, input(text, asked))
    expect(await run(["claude"], JSON.stringify(login))).toEqual({
      code: 0,
      output: `imported the claude login, owned by uid ${process.getuid!()}\n`,
    })
    expect(asked).toEqual([16385])
    expect(await run(["claude"], JSON.stringify(login))).toEqual({
      code: 0,
      output: `replaced the claude login, owned by uid ${process.getuid!()}\n`,
    })
    const refused = async (
      args: ReadonlyArray<string>,
      text: string,
      reason: string,
      with_ = env,
    ) =>
      expect(await run(args, text, with_)).toEqual({
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
    const withDirectory = (directory: string) => ({
      ...env,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...config, login: { directory } }),
    })
    await refused(["claude"], JSON.stringify(login), "the gateway's configuration names no login", {
      ...env,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...config, login: undefined }),
    })
    await refused(["claude"], JSON.stringify(login), "the login was not stored", {
      ...env,
      WORKFLOWD_CAPABILITY_GATEWAY: "{",
    })
    // A new directory is 0700, made under the user's own parent.
    expect(
      (await run(["claude"], JSON.stringify(login), withDirectory(join(root, "fresh")))).code,
    ).toBe(0)
    expect(((await stat(join(root, "fresh"))).mode & 0o777).toString(8)).toBe("700")
    await refused(
      ["claude"],
      JSON.stringify(login),
      `the login was not stored`,
      withDirectory(join(root, "absent", "login")),
    )
    await chmod(join(root, "login"), 0o755)
    await refused(
      ["claude"],
      JSON.stringify(login),
      `custody refused ${join(root, "login")}: mode 0755, custody requires 0700`,
    )
    await rm(join(root, "login"), { recursive: true })
    await symlink(join(root, "fresh"), join(root, "login"))
    await refused(
      ["claude"],
      JSON.stringify(login),
      `custody refused ${join(root, "login")}: not a directory`,
    )
  })
})

test("in this process, custody renews, refuses only invalid_grant, waits between tries, recovers a stopped renewal and keeps a narrowed login", async () => {
  await withLogin(async (root, oauth, env) => {
    const directory = join(root, "login")
    const statePath = join(directory, "claude.state")
    const expired = () =>
      claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    const load = async (login: object) =>
      expect((await importLoginCommand(env, ["claude"], input(JSON.stringify(login)))).code).toBe(0)
    const command = (url = oauth.url) =>
      custodyCommand(["access", directory, "--token-url", url, "claude", "60"])
    /** A later try: the wait of the last failed try is over. */
    const waited = async () => {
      const state = JSON.parse(await readFile(statePath, "utf8"))
      await writeFile(statePath, JSON.stringify({ ...state, retryAt: 0 }), { mode: 0o600 })
    }

    // No login yet.
    await expect(command()).rejects.toThrow(`custody refused ${directory}: no login imported`)
    expect(await loginFault(directory, "claude")).toBe(
      `custody refused ${directory}: no login imported`,
    )
    await checkLogin(directory, "claude")
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
    expect(await loginFault(directory, "claude")).toBeUndefined()

    // A busy server, a 400 that is not invalid_grant, and an answer that does not parse each
    // leave the login and wait: 5 s, then 10, 20 and 40.
    await load(expired())
    const waits: number[] = []
    const causes = {
      busy: "answered 503",
      invalid: "answered 400 invalid_request",
      garbled: "gave no answer that custody reads",
    }
    for (const mode of ["busy", "invalid", "garbled", "busy"] as const) {
      oauth.mode(mode)
      const before = Date.now()
      await expect(command()).rejects.toThrow("no request before")
      const state = JSON.parse(await readFile(statePath, "utf8"))
      waits.push(Math.round((state.retryAt - before) / 1000))
      await expect(command()).rejects.toThrow("the claude login waits to renew until")
      expect(await loginFault(directory, "claude")).toBe(
        `custody: the OAuth server of claude ${causes[mode]}; custody waits before it asks it again`,
      )
      await waited()
    }
    expect(waits).toEqual([5, 10, 20, 40])
    // A Retry-After past the cap waits the cap, 300 s; a renewal clears the wait.
    oauth.mode("limited", { retryAfter: 100000 })
    const before = Date.now()
    await expect(command()).rejects.toThrow("answered 429")
    expect(
      Math.round((JSON.parse(await readFile(statePath, "utf8")).retryAt - before) / 1000),
    ).toBe(300)
    await waited()
    oauth.mode("renew")
    expect((await command()).token).toBe(oauth.next().access)
    expect(await readdir(directory)).not.toContain("claude.state")

    // A refusal is final until a new import.
    await load(expired())
    oauth.mode("refuse")
    await expect(command()).rejects.toThrow("the OAuth server refused its renewal value")
    const requests = oauth.requests().length
    await expect(command()).rejects.toThrow("the OAuth server refused its renewal value")
    expect(oauth.requests()).toHaveLength(requests)
    expect(await loginFault(directory, "claude")).toBe(
      "custody: the claude login needs a new import: the OAuth server refused its renewal value",
    )

    // A renewal that a stopped process left behind is sent again, with the same refresh value.
    const left = expired()
    await load(left)
    await writeFile(statePath, JSON.stringify({ state: "renewing", failures: 0, retryAt: 0 }), {
      mode: 0o600,
    })
    oauth.mode("renew")
    expect((await command()).token).toBe(oauth.next().access)
    expect(sentRefresh(oauth.requests().at(-1))).toBe(left.claudeAiOauth.refreshToken)

    // No scope in the answer keeps the scope; a narrower one is stored and refused.
    await load(expired())
    oauth.mode("unscoped")
    expect((await command()).token).toBe(oauth.next().access)
    await load(expired())
    oauth.mode("narrow")
    await expect(command()).rejects.toThrow(
      "the claude login does not hold the scope user:inference",
    )
    expect(await stored(root)).toBe(oauth.next().access)
    expect(await loginFault(directory, "claude")).toBe(
      "custody: the claude login does not hold the scope user:inference",
    )

    // The production token URL and client id, with the network replaced: no request leaves.
    await load(expired())
    const sent: Array<{ readonly url: string; readonly body: unknown }> = []
    const network = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: url instanceof Request ? url.url : url.toString(),
          body: JSON.parse(typeof init?.body === "string" ? init.body : "null"),
        })
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      },
      { preconnect: network.preconnect },
    )
    try {
      await expect(custodyCommand(["access", directory, "claude", "60"])).rejects.toThrow(
        "refused its renewal value",
      )
    } finally {
      globalThis.fetch = network
    }
    expect(sent.map(({ url }) => url)).toEqual(["https://platform.claude.com/v1/oauth/token"])
    expect(Object.keys(sent[0]?.body ?? {}).sort()).toEqual([
      "client_id",
      "grant_type",
      "refresh_token",
    ])
    expect(sent[0]?.body).toMatchObject({ client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" })

    // The faults of a path, by path and fault.
    await load(expired())
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
}, 30000)

test("in this process, the custody command refuses what its grammar does not hold", async () => {
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
    expect(oauth.requests()).toHaveLength(0)
  })
})

test("in this process, custody stores the renewal value of a 200 whose other fields it does not take, keeps the stored one when a 200 has none, and does not renew within the lead before the first wait", async () => {
  await withLogin(async (root, oauth, env) => {
    const directory = join(root, "login")
    const statePath = join(directory, "claude.state")
    const loginPath = join(directory, "claude.json")
    const expired = () =>
      claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    const load = async (login: object) =>
      expect((await importLoginCommand(env, ["claude"], input(JSON.stringify(login)))).code).toBe(0)
    const command = () =>
      custodyCommand(["access", directory, "--token-url", oauth.url, "claude", "60"])
    const Login = Schema.fromJsonString(
      Schema.Struct({
        claudeAiOauth: Schema.Struct({ refreshToken: Schema.String, expiresAt: Schema.Number }),
      }),
    )
    const login = async () =>
      Schema.decodeUnknownSync(Login)(await readFile(loginPath, "utf8")).claudeAiOauth
    const state = async (value: object) =>
      writeFile(statePath, JSON.stringify(value), { mode: 0o600 })

    // A 200 with expires_in 0: its renewal value is stored, and the try after the wait sends it.
    await load(expired())
    oauth.mode("expired")
    const replaced = oauth.next().refresh
    await expect(command()).rejects.toThrow("a renewal value, which custody stored")
    expect((await login()).refreshToken).toBe(replaced)
    await expect(command()).rejects.toThrow("the claude login waits to renew until")
    await state({ state: "renewing", failures: 1, retryAt: 0 })
    oauth.mode("renew")
    oauth.renewWith({ access: syntheticValue("access"), refresh: syntheticValue("refresh") })
    expect((await command()).token).toBe(oauth.next().access)
    expect(sentRefresh(oauth.requests().at(-1))).toBe(replaced)

    // A 200 with no renewal value keeps the stored one.
    const kept = expired()
    await load(kept)
    oauth.mode("norotate")
    expect((await command()).token).toBe(oauth.next().access)
    expect((await login()).refreshToken).toBe(kept.claudeAiOauth.refreshToken)
    expect(await readdir(directory)).not.toContain("claude.state")

    // An access value within the lead serves calls, with no request, until the first wait ends.
    await load(expired())
    oauth.mode("short")
    const before = oauth.requests().length
    expect((await command()).token).toBe(oauth.next().access)
    expect((await command()).token).toBe(oauth.next().access)
    expect(oauth.requests()).toHaveLength(before + 1)
    // Once that access value ends, a call within the wait gets none.
    const ended = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ claudeAiOauth: Schema.Record(Schema.String, Schema.Unknown) }),
      ),
    )(await readFile(loginPath, "utf8"))
    await writeFile(
      loginPath,
      JSON.stringify({ claudeAiOauth: { ...ended.claudeAiOauth, expiresAt: 0 } }),
    )
    await expect(command()).rejects.toThrow("the claude login waits to renew until")
    expect(oauth.requests()).toHaveLength(before + 1)
    // After the wait, the next call renews.
    await state({ state: "renewed", renewAfter: 0 })
    oauth.mode("renew")
    expect((await command()).token).toBe(oauth.next().access)
    expect(oauth.requests()).toHaveLength(before + 2)
    expect(await readdir(directory)).not.toContain("claude.state")
  })
}, 30000)

test("in this process, a wait on disk past the cap from now is read as the cap, and a Retry-After that is a date, zero, negative or not a number waits as it reads", async () => {
  await withLogin(async (root, oauth, env) => {
    const directory = join(root, "login")
    const statePath = join(directory, "claude.state")
    const expired = () =>
      claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    const load = async () =>
      expect(
        (await importLoginCommand(env, ["claude"], input(JSON.stringify(expired())))).code,
      ).toBe(0)
    const command = () =>
      custodyCommand(["access", directory, "--token-url", oauth.url, "claude", "60"])
    const State = Schema.fromJsonString(Schema.Struct({ retryAt: Schema.Number }))
    const retryAt = async () =>
      Schema.decodeUnknownSync(State)(await readFile(statePath, "utf8")).retryAt

    // A clock set back leaves a wait on disk far past the cap: it is read as the cap from now.
    await load()
    await writeFile(
      statePath,
      JSON.stringify({ state: "renewing", failures: 3, retryAt: Date.now() + 10 * 365 * 86400000 }),
      { mode: 0o600 },
    )
    const before = Date.now()
    const error = await command().then(
      () => undefined,
      (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
    )
    const until = /waits to renew until (\S+)$/.exec(error ?? "")?.[1]
    expect(Date.parse(until ?? "")).toBeGreaterThanOrEqual(before + 300000)
    expect(Date.parse(until ?? "")).toBeLessThanOrEqual(Date.now() + 300000)
    expect(oauth.requests()).toHaveLength(0)
    // The same for the wait after a renewal, whose longest is the first wait, 5 s.
    await writeFile(
      statePath,
      JSON.stringify({ state: "renewed", renewAfter: Date.now() + 10 * 365 * 86400000 }),
      { mode: 0o600 },
    )
    const renewedBefore = Date.now()
    const renewedError = await command().then(
      () => undefined,
      (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
    )
    const renewAfter = Date.parse(/waits to renew until (\S+)$/.exec(renewedError ?? "")?.[1] ?? "")
    expect(renewAfter).toBeGreaterThanOrEqual(renewedBefore + 5000)
    expect(renewAfter).toBeLessThanOrEqual(Date.now() + 5000)

    // Each Retry-After of a 429, after a new import, so that the first wait is 5 s. Custody reads
    // the clock between `sent` and `answered`: a date waits until that date, when it is past the
    // first wait; zero, a negative number and a word ask for nothing.
    const date = new Date(Date.now() + 8000).toUTCString()
    for (const value of [date, "0", "-1", "soon"]) {
      await load()
      oauth.mode("limited", { retryAfter: value })
      const sent = Date.now()
      await expect(command()).rejects.toThrow("answered 429")
      const answered = Date.now()
      const at = await retryAt()
      const target = value === date ? Date.parse(date) : undefined
      if (target === undefined) {
        expect(at - 5000).toBeGreaterThanOrEqual(sent)
        expect(at - 5000).toBeLessThanOrEqual(answered)
      } else {
        expect(at - target).toBeGreaterThanOrEqual(0)
        expect(at - target).toBeLessThanOrEqual(answered - sent)
      }
    }
  })
}, 30000)
