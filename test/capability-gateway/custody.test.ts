import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { chmod, readFile, readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  claudeLogin,
  client,
  custodyEnv,
  fixture,
  gatewaySource,
  importLogin,
  oauthFixture,
  proof,
  sse,
  startGatewayProcess,
  syntheticValue,
  writeCustodyProvider,
  type Fixture,
  type Gateway,
  type OAuthFixture,
} from "./gateway-process"

/**
 * Custody of the gateway's Claude login, through the gateway's public surface: its process, its
 * `import-login` command, its routes and its control socket. The login is synthetic; the OAuth
 * server and the model upstream are fixture HTTP servers in this process.
 */

const loginDirectory = (f: Fixture) => join(f.root, "login")
const loginFile = (f: Fixture) => join(loginDirectory(f), "claude.json")
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8).padStart(4, "0")

/** The forms a value could leak in: plain, base64 and base64url. */
const forms = (value: string) => [
  value,
  Buffer.from(value).toString("base64"),
  Buffer.from(value).toString("base64url"),
]
const leaked = (text: string, values: ReadonlyArray<string>) =>
  values.flatMap(forms).filter((form) => text.includes(form))

/** Every byte of both stores, their journals included. */
async function storeBytes(f: Fixture) {
  const names = (await readdir(f.root)).filter((name) => /\.db(-wal|-shm|-journal)?$/.test(name))
  expect(names).toContain("gateway.db")
  const parts = await Promise.all(names.map((name) => readFile(join(f.root, name))))
  return Buffer.concat(parts).toString("latin1")
}

async function withCustody(
  body: (
    f: Fixture,
    oauth: OAuthFixture,
    start: () => Promise<Gateway>,
    outputs: string[],
  ) => Promise<void>,
) {
  const f = await fixture()
  const oauth = oauthFixture()
  const gateways: Gateway[] = []
  const outputs: string[] = []
  try {
    await writeCustodyProvider(f.root, loginDirectory(f), oauth.url)
    const start = async () => {
      const gateway = await startGatewayProcess(
        [process.execPath, "-e", gatewaySource(f)],
        custodyEnv(f, loginDirectory(f)),
      )
      gateways.push(gateway)
      await f.reconcile()
      return gateway
    }
    await body(f, oauth, start, outputs)
  } finally {
    for (const gateway of gateways) await gateway.stop()
    await oauth.stop()
    await f.close()
  }
}

/** A session of the fixture run on `gateway`, and its run token. */
async function runToken(gateway: Gateway, jti: string) {
  const at = client(gateway.port)
  const challenge = await at.audience()
  const opened = await at.session(proof(challenge.audience, jti))
  expect(opened.status).toBe(200)
  return (await at.grant(opened)).token
}

async function imported(f: Fixture, login: object) {
  const result = await importLogin(custodyEnv(f, loginDirectory(f)), JSON.stringify(login))
  expect(result).toMatchObject({ code: 0, stderr: "" })
  return result
}

test("import-login takes the login on standard input only, into a 0700 directory and a 0600 file of the gateway's uid", async () => {
  const f = await fixture()
  try {
    const env = custodyEnv(f, loginDirectory(f))
    const first = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    const second = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 7200000,
    )
    const values = [first, second].flatMap((login) => [
      login.claudeAiOauth.accessToken,
      login.claudeAiOauth.refreshToken,
    ])
    const outputs: string[] = []
    const run = async (input: string, args?: ReadonlyArray<string>, extra = {}) => {
      const result = await importLogin({ ...env, ...extra }, input, args)
      outputs.push(result.stdout, result.stderr)
      return result
    }

    expect(await run(JSON.stringify(first))).toEqual({
      code: 0,
      stdout: "imported the claude login\n",
      stderr: "",
    })
    const directory = await stat(loginDirectory(f))
    const file = await stat(loginFile(f))
    expect([directory.uid, await mode(loginDirectory(f))]).toEqual([process.getuid!(), "0700"])
    expect([file.uid, await mode(loginFile(f)), file.nlink]).toEqual([process.getuid!(), "0600", 1])
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(first)

    // A login that is there already is replaced as a whole, and the command says so.
    expect(await run(JSON.stringify(second))).toEqual({
      code: 0,
      stdout: "replaced the claude login\n",
      stderr: "",
    })
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(second)
    expect(await readdir(loginDirectory(f))).toEqual(["claude.json"])

    const refused = async (
      input: string,
      reason: string,
      args?: ReadonlyArray<string>,
      extra = {},
    ) => {
      expect(await run(input, args, extra)).toEqual({
        code: 1,
        stdout: "",
        stderr: `import-login refused: ${reason}\n`,
      })
      expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(second)
    }
    // The table of providers holds Claude only.
    await refused(JSON.stringify(first), "no provider codex", ["codex"])
    await refused(JSON.stringify(first), "name one provider", [])
    // Not from an argument and not from the environment.
    await refused("", "the login is read from standard input only", [
      "claude",
      JSON.stringify(first),
    ])
    await refused("", "the login does not parse", ["claude"], {
      CLAUDE_CODE_OAUTH_TOKEN: first.claudeAiOauth.accessToken,
      WORKFLOWD_LOGIN: JSON.stringify(first),
    })
    await refused("{not json", "the login does not parse")
    await refused(
      JSON.stringify({ claudeAiOauth: { accessToken: "x" } }),
      "the login does not parse",
    )
    await refused(
      JSON.stringify({
        claudeAiOauth: { ...first.claudeAiOauth, scopes: ["user:profile"] },
      }),
      "the login does not hold the scope user:inference",
    )
    await refused(
      JSON.stringify({ ...first, padding: "x".repeat(16384) }),
      "the login is longer than 16384 bytes",
    )
    expect(leaked(outputs.join(""), values)).toEqual([])
  } finally {
    await f.close()
  }
})

test("the gateway refuses a login whose directory or file has a wider mode, and names the path and the fault", async () => {
  await withCustody(async (f, oauth, start) => {
    const login = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    const values = [login.claudeAiOauth.accessToken, login.claudeAiOauth.refreshToken]
    await imported(f, login)
    const refusedStart = async () => {
      const child = Bun.spawn([process.execPath, "-e", gatewaySource(f)], {
        cwd: resolve("."),
        env: custodyEnv(f, loginDirectory(f)),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).not.toBe(0)
      expect(stdout).not.toContain("listening")
      expect(leaked(stdout + stderr, values)).toEqual([])
      return stderr
    }

    await chmod(loginDirectory(f), 0o750)
    expect(await refusedStart()).toContain(
      `custody refused ${loginDirectory(f)}: mode 0750, custody requires 0700`,
    )
    const intoWide = await importLogin(custodyEnv(f, loginDirectory(f)), JSON.stringify(login))
    expect(intoWide).toEqual({
      code: 1,
      stdout: "",
      stderr: `import-login refused: custody refused ${loginDirectory(f)}: mode 0750, custody requires 0700\n`,
    })
    await chmod(loginDirectory(f), 0o700)

    await chmod(loginFile(f), 0o640)
    expect(await refusedStart()).toContain(
      `custody refused ${loginFile(f)}: mode 0640, custody requires 0600`,
    )
    await chmod(loginFile(f), 0o600)

    // A gateway that runs refuses to use a login whose mode widens, and names it in its log.
    const gateway = await start()
    const token = await runToken(gateway, "jti-mode")
    await chmod(loginFile(f), 0o644)
    const call = await client(gateway.port).call(token)
    expect(call.status).toBe(503)
    expect(await call.text()).toBe("")
    expect(gateway.output?.()).toContain(
      `custody refused ${loginFile(f)}: mode 0644, custody requires 0600`,
    )
    expect(f.upstreamRequests()).toHaveLength(0)
    expect(oauth.requests()).toHaveLength(0)
    expect(leaked(gateway.output?.() ?? "", values)).toEqual([])
  })
})

test("two calls at one time renew once, the new login is on disk before the upstream uses it, and no value leaves custody", async () => {
  await withCustody(async (f, oauth, start, outputs) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() + 30000)
    const next = oauth.next()
    const values = [
      old.claudeAiOauth.accessToken,
      old.claudeAiOauth.refreshToken,
      next.access,
      next.refresh,
    ]
    const importOutput = await imported(f, old)
    outputs.push(importOutput.stdout, importOutput.stderr)
    const onDisk: string[] = []
    f.onUpstream(async () => {
      onDisk.push(JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth.accessToken)
    })
    const gateway = await start()
    const token = await runToken(gateway, "jti-renew")

    const calls = await Promise.all([
      client(gateway.port).call(token),
      client(gateway.port).call(token),
    ])
    const answers: string[] = []
    for (const call of calls) {
      expect(call.status).toBe(200)
      const text = await call.text()
      expect(text).toBe(sse)
      answers.push(JSON.stringify([...call.headers]), text)
    }

    expect(oauth.requests()).toHaveLength(1)
    expect(JSON.parse(oauth.requests()[0]?.body ?? "{}")).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: old.claudeAiOauth.refreshToken,
    })
    // The upstream got the new value only, and the new login was on disk when it did.
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${next.access}`,
      `Bearer ${next.access}`,
    ])
    expect(onDisk).toEqual([next.access, next.access])
    const stored = JSON.parse(await readFile(loginFile(f), "utf8"))
    expect(stored.claudeAiOauth).toMatchObject({
      accessToken: next.access,
      refreshToken: next.refresh,
      subscriptionType: "fixture",
    })
    expect(stored.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 3500000)
    expect(await mode(loginFile(f))).toBe("0600")
    expect(await readdir(loginDirectory(f))).toEqual(["claude.json", "claude.lock"])

    // A call on a fresh login does not renew it.
    const later = await client(gateway.port).call(token)
    answers.push(await later.text())
    expect(oauth.requests()).toHaveLength(1)

    // No value in the answers of the routes, the output of the processes or the stores.
    const at = client(gateway.port)
    const challenge = await at.challenge("lease")
    answers.push(await challenge.text())
    const opened = await at.session(proof((await at.audience()).audience, "jti-values"))
    answers.push(await opened.text())
    for (const path of ["/capabilities/v1/login", "/capabilities/v1/import-login"]) {
      const route = await fetch(at.url(path), { method: "POST", body: JSON.stringify(old) })
      expect([403, 404]).toContain(route.status)
      answers.push(await route.text())
    }
    expect(leaked(answers.join(""), values)).toEqual([])
    expect(leaked((gateway.output?.() ?? "") + outputs.join(""), values)).toEqual([])
    expect(leaked(await storeBytes(f), values)).toEqual([])
  })
})

test("no verb of the control socket imports or returns a login", async () => {
  await withCustody(async (f, _oauth, start) => {
    const login = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    await imported(f, login)
    await start()
    for (const verb of ["importLogin", "login", "access", "custody"]) {
      const answer = await rawFrame(f.config.controlSocket, { verb, body: login })
      expect(JSON.parse(answer)).toEqual({ ok: false, error: "verb" })
    }
  })
})

test("a refusal of the OAuth server leaves a state that asks for a new import, and is not asked again", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("refuse")
    const gateway = await start()
    const token = await runToken(gateway, "jti-refused")
    for (const _ of [1, 2, 3]) {
      const call = await client(gateway.port).call(token)
      expect(call.status).toBe(503)
      expect(await call.text()).toBe("")
    }
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests()).toHaveLength(0)
    expect(gateway.output?.()).toContain(
      "custody: the claude login needs a new import: the OAuth server refused its renewal",
    )
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(old)

    // A new import is the way out: the next call uses it, with no request to the OAuth server.
    const fresh = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    await imported(f, fresh)
    const call = await client(gateway.port).call(token)
    expect(await call.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${fresh.claudeAiOauth.accessToken}`,
    ])
  })
})

test("an OAuth server that does not answer ends the call at the time limit, with no upstream call on the old value", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("silent")
    const gateway = await start()
    const token = await runToken(gateway, "jti-silent")
    const began = performance.now()
    const call = await client(gateway.port).call(token)
    const took = performance.now() - began
    expect(call.status).toBe(503)
    expect(took).toBeGreaterThanOrEqual(5000)
    expect(took).toBeLessThan(9000)
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests()).toHaveLength(0)
    expect(gateway.output?.()).toContain(
      "custody: the claude login needs a new import: its renewal got no answer within 5 seconds",
    )
    // The OAuth server may have taken the old refresh value: it is not sent again.
    const again = await client(gateway.port).call(token)
    expect(again.status).toBe(503)
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests()).toHaveLength(0)
  })
}, 20000)

/** One frame on the control socket: a 4-byte length, then the JSON. */
function rawFrame(socket: string, value: unknown) {
  return new Promise<string>((done) => {
    const body = Buffer.from(JSON.stringify(value))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const connection = createConnection(socket)
    let answer = Buffer.alloc(0)
    connection.on("connect", () => connection.write(Buffer.concat([header, body])))
    connection.on("data", (chunk) => {
      answer = Buffer.concat([answer, Buffer.from(chunk)])
    })
    connection.on("error", () => done("error"))
    connection.on("close", () => done(answer.subarray(4).toString("utf8")))
  })
}
