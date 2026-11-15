import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { join, resolve } from "node:path"
import { Effect, Exit, Scope } from "effect"
import { serveCapabilityGateway } from "../../src/capability-gateway-server"
import {
  claudeLogin,
  client,
  custodyEnv,
  fixture,
  gatewaySource,
  importLogin,
  oauthFixture,
  proof,
  sentRefresh,
  sse,
  startGatewayProcess,
  storedAccess,
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
    expect((await readdir(loginDirectory(f))).sort()).toEqual(["claude.json", "claude.lock"])

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

    // Not into a new directory whose parent belongs to another user: the gateway would refuse it.
    const foreign = `/tmp/wfd-login-${randomUUID()}`
    expect((await stat("/tmp")).uid).not.toBe(process.getuid!())
    expect(await importLogin(custodyEnv(f, foreign), JSON.stringify(first))).toEqual({
      code: 1,
      stdout: "",
      stderr: `import-login refused: /tmp belongs to uid ${(await stat("/tmp")).uid}: import-login runs as the gateway's user, which owns it\n`,
    })
    expect(await stat(foreign).catch(() => "absent")).toBe("absent")
  } finally {
    await f.close()
  }
}, 30000)

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
      const child = Bun.spawn([process.execPath, resolve("src/capability-gateway-server.ts")], {
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
      // The process's logger writes the failure that ends it on standard output.
      return stdout + stderr
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

    // The noscope provider names the login directory of the configuration, or the gateway stops.
    await writeCustodyProvider(f.root, join(f.root, "elsewhere"), oauth.url)
    expect(await refusedStart()).toContain(
      `the noscope provider provider-access names ${join(f.root, "elsewhere")}, not the login directory ${loginDirectory(f)}`,
    )
    await writeCustodyProvider(f.root, loginDirectory(f), oauth.url)

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
}, 30000)

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
      onDisk.push(storedAccess(await readFile(loginFile(f), "utf8")))
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
    // The body holds these fields and no other; the client id is Claude Code's public one.
    expect(JSON.parse(oauth.requests()[0]?.body ?? "{}")).toEqual({
      grant_type: "refresh_token",
      refresh_token: old.claudeAiOauth.refreshToken,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
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
    expect((await readdir(loginDirectory(f))).sort()).toEqual(["claude.json", "claude.lock"])

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
}, 30000)

test("a call that fails for a cause of the configuration logs the cause, once for calls that repeat it", async () => {
  await withCustody(async (f, oauth, start) => {
    // No login key: the gateway starts, and each provider call names the missing key.
    const keyless = await startGatewayProcess([process.execPath, "-e", gatewaySource(f)], {
      ...f.env,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...f.config, credentialRole: "claude" }),
    })
    try {
      await f.reconcile()
      const token = await runToken(keyless, "jti-keyless")
      for (let attempt = 0; attempt < 3; attempt++) {
        const call = await client(keyless.port).call(token)
        expect(call.status).toBe(503)
        await call.text()
      }
      const line = "custody: the gateway's configuration names no login directory for claude"
      expect(keyless.output?.().split(line)).toHaveLength(2)
    } finally {
      await keyless.stop()
    }

    // A login key, and no login imported yet.
    const gateway = await start()
    const token = await runToken(gateway, "jti-nologin")
    for (let attempt = 0; attempt < 3; attempt++) {
      const call = await client(gateway.port).call(token)
      expect(call.status).toBe(503)
      await call.text()
    }
    const line = `custody refused ${loginDirectory(f)}: no login imported`
    expect(gateway.output?.().split(line)).toHaveLength(2)
    expect(oauth.requests()).toHaveLength(0)
  })
}, 30000)

test("each search for a value finds one put on purpose in its output: the gateway's, import-login's, a route answer and the stores", async () => {
  await withCustody(async (f, oauth, start, outputs) => {
    // The gateway's output: a login directory whose name holds the value, in a fault line.
    const inLog = syntheticValue("planted")
    const directory = join(f.root, `login-${inLog}`)
    await writeCustodyProvider(f.root, directory, oauth.url)
    const gateway = await startGatewayProcess(
      [process.execPath, "-e", gatewaySource(f)],
      custodyEnv(f, directory),
    )
    try {
      await f.reconcile()
      const token = await runToken(gateway, "jti-planted")
      expect((await client(gateway.port).call(token)).status).toBe(503)
      expect(leaked(gateway.output?.() ?? "", [inLog])).toEqual([inLog])

      // A route answer: the upstream's answer, which the gateway passes on.
      const inAnswer = syntheticValue("planted")
      f.setAnswerText(`data: ${Buffer.from(inAnswer).toString("base64")}\n\n`)
      const login = claudeLogin(
        syntheticValue("access"),
        syntheticValue("refresh"),
        Date.now() + 3600000,
      )
      expect((await importLogin(custodyEnv(f, directory), JSON.stringify(login))).code).toBe(0)
      const call = await client(gateway.port).call(token)
      expect(leaked(await call.text(), [inAnswer])).toContain(
        Buffer.from(inAnswer).toString("base64"),
      )
    } finally {
      await gateway.stop()
    }

    // import-login's output: a provider name that holds the value, in base64url.
    const inImport = syntheticValue("planted")
    const named = await importLogin(custodyEnv(f, loginDirectory(f)), "", [
      Buffer.from(inImport).toString("base64url"),
    ])
    outputs.push(named.stdout, named.stderr)
    expect(leaked(outputs.join(""), [inImport])).toContain(
      Buffer.from(inImport).toString("base64url"),
    )

    // The stores: a row of workflowd's store.
    const inStore = syntheticValue("planted")
    await f.sql((sql) =>
      sql`CREATE TABLE planted(value TEXT)`.pipe(
        Effect.andThen(sql`INSERT INTO planted VALUES(${inStore})`),
      ),
    )
    expect(leaked(await storeBytes(f), [inStore])).toEqual([inStore])
  })
}, 30000)

test("the gateway process writes no core file: its core limit is 0, which the processes it starts inherit", async () => {
  await withCustody(async (_f, _oauth, start) => {
    const gateway = await start()
    const limits = await readFile(`/proc/${gateway.pid}/limits`, "utf8")
    expect(/^Max core file size\s+(\S+)\s+(\S+)/m.exec(limits)?.slice(1)).toEqual(["0", "0"])
  })
}, 30000)

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
}, 30000)

test("only a refusal of the renewal value (400 invalid_grant) asks for a new import, and it is not asked again", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("refuse")
    const gateway = await start()
    const token = await runToken(gateway, "jti-refused")
    for (let attempt = 0; attempt < 3; attempt++) {
      const call = await client(gateway.port).call(token)
      expect(call.status).toBe(503)
      expect(await call.text()).toBe("")
    }
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests()).toHaveLength(0)
    const line =
      "custody: the claude login needs a new import: the OAuth server refused its renewal value"
    // A client that repeats its call does not repeat the line.
    expect(gateway.output?.().split(line)).toHaveLength(2)
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
}, 30000)

/** Calls on `token` until `at` (a time of `Date.now()`): each gets 503, and none asks the OAuth server. */
async function quietUntil(gateway: Gateway, token: string, oauth: OAuthFixture, at: number) {
  const before = oauth.requests().length
  let calls = 0
  while (Date.now() < at - 400) {
    const call = await client(gateway.port).call(token)
    expect(call.status).toBe(503)
    await call.text()
    calls++
    await Bun.sleep(250)
  }
  expect(calls).toBeGreaterThan(0)
  expect(oauth.requests()).toHaveLength(before)
  await Bun.sleep(Math.max(0, at - Date.now()) + 100)
}

/** The call works with the fixture's next access value; the OAuth server got one more request. */
async function works(gateway: Gateway, token: string, oauth: OAuthFixture, old: string) {
  const before = oauth.requests().length
  const call = await client(gateway.port).call(token)
  expect(call.status).toBe(200)
  expect(await call.text()).toBe(sse)
  expect(oauth.requests()).toHaveLength(before + 1)
  expect(sentRefresh(oauth.requests().at(-1))).toBe(old)
}

test("an OAuth server that does not answer leaves the login as it was; no request goes out for 5 seconds, then one does", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("silent")
    const gateway = await start()
    const token = await runToken(gateway, "jti-silent")
    const began = performance.now()
    const call = await client(gateway.port).call(token)
    const failedAt = Date.now()
    const took = performance.now() - began
    expect(call.status).toBe(503)
    expect(took).toBeGreaterThanOrEqual(5000)
    expect(took).toBeLessThan(9000)
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests()).toHaveLength(0)
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(old)
    expect(gateway.output?.()).toContain(
      "custody: the claude login was not renewed; custody waits before it asks the OAuth server again",
    )
    expect(gateway.output?.()).not.toContain("needs a new import")
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, failedAt + 5000)
    await works(gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${oauth.next().access}`,
    ])
  })
}, 40000)

test("a 429 waits for its Retry-After when that is longer, and a 503 doubles the wait", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const refresh = old.claudeAiOauth.refreshToken
    const gateway = await start()
    const token = await runToken(gateway, "jti-busy")
    // 429 with Retry-After 7: longer than the first wait of 5 seconds.
    oauth.mode("limited", { retryAfter: 7 })
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const limitedAt = Date.now()
    await quietUntil(gateway, token, oauth, limitedAt + 6000)
    expect((await client(gateway.port).call(token)).status).toBe(503)
    expect(oauth.requests()).toHaveLength(1)
    await Bun.sleep(Math.max(0, limitedAt + 7100 - Date.now()))
    // The second failed try, a 503, waits twice the first wait: 10 seconds.
    oauth.mode("busy")
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const busyAt = Date.now()
    expect(oauth.requests()).toHaveLength(2)
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, busyAt + 10000)
    await works(gateway, token, oauth, refresh)
    expect(oauth.requests().map(sentRefresh)).toEqual([refresh, refresh, refresh])
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth.refreshToken).toBe(
      oauth.next().refresh,
    )
  })
}, 40000)

test("a 400 that is not invalid_grant does not ask for a new import", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("invalid")
    const gateway = await start()
    const token = await runToken(gateway, "jti-invalid")
    expect((await client(gateway.port).call(token)).status).toBe(503)
    const failedAt = Date.now()
    oauth.mode("renew")
    await quietUntil(gateway, token, oauth, failedAt + 5000)
    await works(gateway, token, oauth, old.claudeAiOauth.refreshToken)
    expect(gateway.output?.()).not.toContain("needs a new import")
  })
}, 30000)

/** A Claude call on `port` that the client gives up when `signal` aborts. */
const callUntil = (port: number, token: string, signal: AbortSignal) =>
  fetch(client(port).url("/capabilities/v1/providers/anthropic/v1/messages"), {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({ model: "fixture-model", stream: true, messages: [] }),
  })

/** Waits until `ready` holds, for at most 10 seconds. */
async function until(ready: () => boolean) {
  const end = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > end) throw new Error("the condition did not come")
    await Bun.sleep(20)
  }
}

test("a client that goes away while the OAuth server holds the renewal ends its own wait only; the next call uses that renewal", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("hold")
    const gateway = await start()
    const token = await runToken(gateway, "jti-away")
    const away = new AbortController()
    const first = callUntil(gateway.port, token, away.signal).catch(() => "gone")
    await until(() => oauth.requests().length === 1)
    away.abort()
    expect(await first).toBe("gone")
    await Bun.sleep(300)
    oauth.release()
    const second = await client(gateway.port).call(token)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(oauth.next().access)
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${oauth.next().access}`,
    ])
  })
}, 30000)

/** An exclusive advisory lock on `path`, as a custody process takes it, until `release`. */
function holdLock(path: string) {
  const libc = dlopen("libc.so.6", {
    open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  const fd = libc.symbols.open(ptr(Buffer.from(`${path}\0`)), 2)
  if (fd < 0 || libc.symbols.flock(fd, 2) !== 0) throw new Error("the lock was not taken")
  return () => {
    libc.symbols.close(fd)
    libc.close()
  }
}

test("the gateway's time limit of one call ends that call's wait; the renewal goes on and the next call uses it", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    const gateway = await start()
    const token = await runToken(gateway, "jti-timer")
    // Custody waits up to 15 seconds for the lock; the call waits 10.
    const release = holdLock(join(loginDirectory(f), "claude.lock"))
    let released = false
    try {
      const began = performance.now()
      const call = await client(gateway.port).call(token)
      expect(call.status).toBe(503)
      expect(performance.now() - began).toBeLessThan(12000)
      expect(oauth.requests()).toHaveLength(0)
      release()
      released = true
      await until(() => oauth.requests().length === 1)
    } finally {
      if (!released) release()
    }
    const next = await client(gateway.port).call(token)
    expect(next.status).toBe(200)
    expect(await next.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
  })
}, 40000)

test("a stop of the gateway while the OAuth server holds the renewal: after a start, the same refresh value is sent once more and the call works", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("hold")
    const gateway = await start()
    const token = await runToken(gateway, "jti-stop")
    const first = client(gateway.port)
      .call(token)
      .catch(() => "gone")
    await until(() => oauth.requests().length === 1)
    await gateway.terminate?.()
    await first
    // The custody process ended with the gateway: the held answer is stored by no one.
    oauth.release()
    await Bun.sleep(300)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(old.claudeAiOauth.accessToken)
    oauth.mode("renew")
    const restarted = await start()
    await works(
      restarted,
      await runToken(restarted, "jti-restart"),
      oauth,
      old.claudeAiOauth.refreshToken,
    )
    expect(oauth.requests()).toHaveLength(2)
    expect(storedAccess(await readFile(loginFile(f), "utf8"))).toBe(oauth.next().access)
  })
}, 40000)

test("a stop after the renewed login is complete and before its rename: the next call stores it and sends no request", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    // What such a stop leaves: the state written before the request, and the complete new login
    // in a temporary file of mode 0600 beside the old one.
    const renewed = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    const older = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() - 5000,
    )
    await writeFile(
      join(loginDirectory(f), "claude.state"),
      JSON.stringify({ state: "renewing", failures: 0, retryAt: 0 }),
      { mode: 0o600 },
    )
    await writeFile(
      join(loginDirectory(f), `claude.json.${randomUUID()}.tmp`),
      JSON.stringify(renewed),
      { mode: 0o600 },
    )
    // A temporary file that ends earlier, and one cut short, are not the login.
    await writeFile(
      join(loginDirectory(f), `claude.json.${randomUUID()}.tmp`),
      JSON.stringify(older),
      { mode: 0o600 },
    )
    await writeFile(
      join(loginDirectory(f), `claude.json.${randomUUID()}.tmp`),
      JSON.stringify(renewed).slice(0, 60),
      { mode: 0o600 },
    )
    const gateway = await start()
    const token = await runToken(gateway, "jti-tmp")
    const call = await client(gateway.port).call(token)
    expect(call.status).toBe(200)
    expect(await call.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(0)
    expect(JSON.parse(await readFile(loginFile(f), "utf8"))).toEqual(renewed)
    expect((await readdir(loginDirectory(f))).sort()).toEqual(["claude.json", "claude.lock"])
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${renewed.claudeAiOauth.accessToken}`,
    ])
  })
}, 30000)

test("a renewal answer with no scope keeps the scope; one without user:inference is stored, and calls are refused for that scope", async () => {
  await withCustody(async (f, oauth, start) => {
    const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000)
    await imported(f, old)
    oauth.mode("unscoped")
    const gateway = await start()
    const token = await runToken(gateway, "jti-scope")
    const call = await client(gateway.port).call(token)
    expect(call.status).toBe(200)
    expect(await call.text()).toBe(sse)
    const kept = JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth
    expect([kept.accessToken, kept.scopes]).toEqual([
      oauth.next().access,
      ["user:inference", "user:profile"],
    ])

    // The server answers with a narrower scope: it has replaced the refresh value, so the new
    // values are stored, and no call gets an access value.
    await imported(
      f,
      claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() - 1000),
    )
    const narrow = { access: syntheticValue("access"), refresh: syntheticValue("refresh") }
    oauth.renewWith(narrow)
    oauth.mode("narrow")
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await client(gateway.port).call(token)
      expect(refused.status).toBe(503)
      await refused.text()
    }
    expect(oauth.requests()).toHaveLength(2)
    const stored = JSON.parse(await readFile(loginFile(f), "utf8")).claudeAiOauth
    expect([stored.accessToken, stored.refreshToken, stored.scopes]).toEqual([
      narrow.access,
      narrow.refresh,
      ["user:profile"],
    ])
    expect(gateway.output?.()).toContain(
      "custody: the claude login does not hold the scope user:inference",
    )
    expect(gateway.output?.()).not.toContain("needs a new import")
    expect(f.upstreamRequests()).toHaveLength(1)
  })
}, 30000)

test("the fixture OAuth server refuses another client id", async () => {
  const oauth = oauthFixture()
  try {
    const answer = await fetch(oauth.url, {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "x", client_id: "other" }),
    })
    expect([answer.status, await answer.json()]).toEqual([401, { error: "invalid_client" }])
  } finally {
    await oauth.stop()
  }
})

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

test("in this process, the gateway refuses a login it cannot hold and logs a login that needs a new import", async () => {
  await withCustody(async (f, oauth) => {
    const env = custodyEnv(f, loginDirectory(f))
    const serve = (with_: Record<string, string | undefined>) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const served = yield* serveCapabilityGateway(with_, {
          keys: async (signal) => (await fetch(f.keysUrl, { signal })).json(),
          upstream: (url, init) =>
            fetch(url.replace("https://api.anthropic.com", f.upstreamUrl), init),
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        return { port: served.port, stop: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
      })
    const role = await Effect.runPromise(
      Effect.flip(
        serve({
          ...env,
          WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
            ...f.config,
            credentialRole: "fixture",
            login: { directory: loginDirectory(f) },
          }),
        }),
      ),
    )
    expect(String(role)).toContain("custody holds no provider fixture")

    const login = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() - 1000,
    )
    await imported(f, login)
    await chmod(loginDirectory(f), 0o711)
    const wide = await Effect.runPromise(Effect.flip(serve(env)))
    expect(String(wide)).toContain(
      `custody refused ${loginDirectory(f)}: mode 0711, custody requires 0700`,
    )
    await chmod(loginDirectory(f), 0o700)

    oauth.mode("refuse")
    const gateway = await Effect.runPromise(serve(env))
    try {
      await f.reconcile()
      const token = await runToken({ ...gateway }, "jti-in-process")
      const call = await client(gateway.port).call(token)
      expect(call.status).toBe(503)
      expect(oauth.requests()).toHaveLength(1)
      expect(f.upstreamRequests()).toHaveLength(0)
    } finally {
      await gateway.stop()
    }
  })
}, 30000)
