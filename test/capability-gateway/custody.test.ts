import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { chmod, readFile, readdir, stat } from "node:fs/promises"
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
  sse,
  startGatewayProcess,
  storedAccess,
  syntheticValue,
  writeCustodyProvider,
} from "./gateway-process"
import {
  imported,
  leaked,
  loginDirectory,
  loginFile,
  mode,
  runToken,
  storeBytes,
  withCustody,
} from "./custody-fixture"

/**
 * Custody of the gateway's Claude login, through the gateway's public surface: its process, its
 * `import-login` command, its routes and its control socket. The login is synthetic; the OAuth
 * server and the model upstream are fixture HTTP servers in this process.
 */

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
    const foreign = `/wfd-login-${randomUUID()}`
    const rootOwner = (await stat("/")).uid
    expect(rootOwner).not.toBe(process.getuid!())
    expect(await importLogin(custodyEnv(f, foreign), JSON.stringify(first))).toEqual({
      code: 1,
      stdout: "",
      stderr: `import-login refused: / belongs to uid ${rootOwner}: import-login runs as the gateway's user, which owns it\n`,
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
    const call = await client(gateway).call(token)
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

    const calls = await Promise.all([client(gateway).call(token), client(gateway).call(token)])
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
    const later = await client(gateway).call(token)
    answers.push(await later.text())
    expect(oauth.requests()).toHaveLength(1)

    // No value in the answers of the routes, the output of the processes or the stores.
    const at = client(gateway)
    const challenge = await at.challenge("lease")
    answers.push(await challenge.text())
    const opened = await at.session(proof((await at.audience()).audience, "jti-values"))
    answers.push(await opened.text())
    for (const path of ["/capabilities/v1/login", "/capabilities/v1/import-login"]) {
      const route = await at.request(path, { method: "POST", body: JSON.stringify(old) })
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
    const keyless = await startGatewayProcess(
      [process.execPath, "-e", gatewaySource(f)],
      {
        ...f.env,
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...f.config, credentialRole: "claude" }),
      },
      f.front,
    )
    try {
      await f.reconcile()
      const token = await runToken(keyless, "jti-keyless")
      for (let attempt = 0; attempt < 3; attempt++) {
        const call = await client(keyless).call(token)
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
      const call = await client(gateway).call(token)
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
      f.front,
    )
    try {
      await f.reconcile()
      const token = await runToken(gateway, "jti-planted")
      expect((await client(gateway).call(token)).status).toBe(503)
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
      const call = await client(gateway).call(token)
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
      const call = await client(gateway).call(token)
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
    const call = await client(gateway).call(token)
    expect(await call.text()).toBe(sse)
    expect(oauth.requests()).toHaveLength(1)
    expect(f.upstreamRequests().map((request) => request.headers.authorization)).toEqual([
      `Bearer ${fresh.claudeAiOauth.accessToken}`,
    ])
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
        yield* serveCapabilityGateway(with_, {
          keys: async (signal) => (await fetch(f.keysUrl, { signal })).json(),
          upstream: (url, init) =>
            fetch(url.replace("https://api.anthropic.com", f.upstreamUrl), init),
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        return {
          origin: f.front.origin,
          ca: f.front.ca,
          stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        }
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
      const call = await client(gateway).call(token)
      expect(call.status).toBe(503)
      expect(oauth.requests()).toHaveLength(1)
      expect(f.upstreamRequests()).toHaveLength(0)
    } finally {
      await gateway.stop()
    }
  })
}, 30000)
