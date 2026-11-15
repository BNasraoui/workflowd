import "../resources/preload"
import { strict as assert } from "node:assert"
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  claudeLogin,
  client,
  fixture,
  oauthFixture,
  syntheticValue,
  writeCustodyProvider,
  gatewaySource,
  proof,
  sse,
  startGatewayProcess,
  type Fixture,
  type Gateway,
} from "../capability-gateway/gateway-process"

/**
 * The gateway image under Docker, against the session fixtures. The preload holds the run under
 * the test resource guard, as test/resources/run.ts does: workflowd's store and the gateway's,
 * the noscope providers, key server and model upstream, with the image's own Bun, modules and
 * noscope. Each container runs as the image's own user. This process is workflowd: it grants the
 * fixture run on the gateway's control socket, which the container serves for the runner's uid
 * and group.
 */
const image = "workflowd-gateway:local"
const imageUser = "10001"
let started = 0

/** The runner's group; each container adds it to the image's user to reach the fixture. */
function runnerGroup() {
  const gid = process.getgid?.()
  if (gid === undefined) throw new Error("the runner has no group to share the fixture with")
  return String(gid)
}

/**
 * The fixture root is the image user's, with the runner's group and mode 01770, as the gateway
 * requires of each directory above its control directory: the runner writes its fixtures there
 * through its group, and the sticky bit keeps it from replacing an entry of the image's user. The
 * image's user writes its store, makes its control directory, writes the mint records and their
 * directories, and reads the noscope providers, which noscope accepts with group read and no
 * access for others. The providers start their scripts with the image's Bun.
 */
async function fixtureForImageUser(f: Fixture) {
  for (const name of ["run-capability", "provider-access"]) {
    const path = join(f.root, `noscope/providers/${name}.toml`)
    await writeFile(path, (await readFile(path, "utf8")).replaceAll(process.execPath, "/bin/bun"))
    await chmod(path, 0o640)
  }
  for (const directory of ["noscope", "noscope/providers"])
    await chmod(join(f.root, directory), 0o750)
  await chmod(join(f.root, "live"), 0o770)
  for (const entry of await readdir(f.root, { withFileTypes: true }))
    if (entry.isFile()) await chmod(join(f.root, entry.name), 0o660)
  // coreutils' chmod sets the sticky bit, and a change of owner keeps it.
  await Bun.$`chmod 1770 ${f.root}`
  await asRoot(
    f,
    `require("node:fs").chownSync(${JSON.stringify(f.root)}, ${imageUser}, ${runnerGroup()})`,
  )
}

/** A container of the image as root, which may change the owner of a fixture path. */
async function asRoot(f: Fixture, source: string) {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "0:0",
      "--volume",
      `${f.root}:${f.root}`,
      "--entrypoint",
      "/bin/bun",
      image,
      "-e",
      source,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  if ((await child.exited) !== 0) throw new Error("a container as root failed on the fixture")
}

/** The ids of the container's first process, the gateway, as /proc shows them inside. */
async function gatewayIds(name: string) {
  const read = Bun.spawn(
    [
      "docker",
      "exec",
      name,
      "/bin/bun",
      "-e",
      'process.stdout.write(require("node:fs").readFileSync("/proc/1/status", "utf8"))',
    ],
    { stdout: "pipe", stderr: "inherit" },
  )
  const status = await new Response(read.stdout).text()
  if ((await read.exited) !== 0) throw new Error(`cannot read the gateway's ids in ${name}`)
  const field = (key: string) =>
    new RegExp(`^${key}:(.*)$`, "m").exec(status)?.[1]?.trim().split(/\s+/) ?? []
  return { uid: field("Uid"), gid: field("Gid"), groups: field("Groups") }
}

/**
 * A container of the image on the host network. `entrypoint` runs the image's own command; else
 * the image's Bun runs the same server with the fixture's key server and upstream, as the gateway
 * process of the session tests does. No `--user` replaces the image's user.
 */
async function imageGateway(
  f: Fixture,
  entrypoint: boolean,
  custody: object = {},
): Promise<Gateway> {
  const name = `workflowd-gateway-image-${process.pid}-${++started}`
  const group = runnerGroup()
  const config = imageConfig(f, custody)
  const removed = async () => {
    await Bun.spawn(["docker", "rm", "--force", name], { stdout: "ignore", stderr: "ignore" })
      .exited
  }
  const container = await startGatewayProcess(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "host",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--group-add",
      group,
      "--volume",
      `${f.root}:${f.root}`,
      "--env",
      "WORKFLOWD_CAPABILITY_GATEWAY",
      ...(entrypoint
        ? [image]
        : [
            "--entrypoint",
            "/bin/bun",
            image,
            "-e",
            gatewaySource(f, "/app/src/capability-gateway-server.ts"),
          ]),
    ],
    { PATH: process.env.PATH, WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config) },
  ).catch(async (error: unknown) => {
    await removed()
    throw error
  })
  // The container goes first; then the docker client that ran it ends.
  const stop = async () => {
    await removed()
    await container.stop()
  }
  try {
    const ids = await gatewayIds(name)
    assert.deepEqual(ids.uid, [imageUser, imageUser, imageUser, imageUser])
    assert.deepEqual(ids.gid, [imageUser, imageUser, imageUser, imageUser])
    assert.ok(
      ids.groups.includes(group),
      `the gateway lacks the runner's group: ${ids.groups.join(" ")}`,
    )
  } catch (error) {
    await stop()
    throw error
  }
  await f.reconcile().catch(async (error: unknown) => {
    await stop()
    throw error
  })
  return { port: container.port, stop }
}

/** The gateway's configuration in the image; `custody` adds the login that custody holds. */
const imageConfig = (f: Fixture, custody: object = {}) => ({
  ...f.config,
  noscope: { binary: "/bin/noscope", configHome: f.root },
  daemon: { uid: process.getuid!(), gid: Number(runnerGroup()) },
  ...custody,
})

/** The flags of each container of the image, as Phase 1 runs it. */
const containerFlags = (f: Fixture) => [
  "--read-only",
  "--tmpfs",
  "/tmp",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--group-add",
  runnerGroup(),
  "--volume",
  `${f.root}:${f.root}`,
]

/** A container of the image as its own user, with the image's Bun running `source`; its output. */
async function asImageUser(f: Fixture, source: string) {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      ...containerFlags(f),
      "--entrypoint",
      "/bin/bun",
      image,
      "-e",
      source,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

/**
 * The image's own command with `args`, `input` on its standard input and the gateway's
 * configuration with custody: `import-login`, or a start that custody refuses.
 */
async function imageCommand(
  f: Fixture,
  custody: object,
  args: ReadonlyArray<string>,
  input?: string,
) {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--interactive",
      "--network",
      "host",
      ...containerFlags(f),
      "--env",
      "WORKFLOWD_CAPABILITY_GATEWAY",
      image,
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(imageConfig(f, custody)),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (input !== undefined) child.stdin.write(input)
  await child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

/**
 * The fixture root and what the image's user made in it go back to the runner, which then
 * removes them.
 */
async function returnFixtureRoot(f: Fixture) {
  await asRoot(
    f,
    `const fs = require("node:fs"); const walk = (path) => { fs.lchownSync(path, ${process.getuid!()}, ${runnerGroup()}); if (fs.lstatSync(path).isDirectory()) for (const name of fs.readdirSync(path)) walk(path + "/" + name) }
walk(${JSON.stringify(f.root)}); fs.chmodSync(${JSON.stringify(f.root)}, 0o700)`,
  )
}

const loginDirectory = (f: Fixture) => join(f.root, "login")

const f = await fixture()
const oauth = oauthFixture()
const gateways: Gateway[] = []
const start = async (entrypoint = false, custody: object = {}) => {
  const gateway = await imageGateway(f, entrypoint, custody)
  gateways.push(gateway)
  return gateway
}
try {
  await fixtureForImageUser(f)

  // The image's own command migrates the store, listens and issues a challenge.
  const own = await start(true)
  const ownChallenge = await client(own.port).challenge("lease")
  assert.equal(ownChallenge.status, 200)
  await own.stop()

  let gateway = await start()
  const at = () => client(gateway.port)

  // A first proof opens a session; its token reaches the upstream through the gateway.
  const first = await at().audience()
  const opened = await at().session(proof(first.audience, "jti-1"))
  assert.equal(opened.status, 200)
  const firstGrant = await at().grant(opened)
  assert.match(firstGrant.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(await (await at().call(firstGrant.token)).text(), sse)

  // A second proof on a new challenge opens the next session and ends the first token.
  const second = await at().audience()
  assert.notEqual(second.nonce, first.nonce)
  const reopened = await at().session(proof(second.audience, "jti-2"))
  assert.equal(reopened.status, 200)
  const grant = await at().grant(reopened)
  assert.equal((await at().call(firstGrant.token)).status, 403)
  assert.equal(await (await at().call(grant.token)).text(), sse)

  // The container restarts on the same store; the run's token still works, used proofs do not.
  await gateway.stop()
  gateway = await start()
  assert.equal(await (await at().call(grant.token)).text(), sse)
  // A client sees a final refusal only as a 403 with no body; a refusal it may retry is a 503.
  // The same challenge then takes a fresh proof, so the used jti is the only reason refused.
  const third = await at().audience()
  const replayed = await at().session(proof(third.audience, "jti-2"))
  assert.equal(replayed.status, 403)
  assert.equal(await replayed.text(), "")
  const fresh = await at().session(proof(third.audience, "jti-3"))
  assert.equal(fresh.status, 200)
  const freshGrant = await at().grant(fresh)
  assert.equal((await at().call(grant.token)).status, 403)
  assert.equal((await at().call(firstGrant.token)).status, 403)

  // The upstream saw each allowed call, and never a run token.
  const calls = f.upstreamRequests()
  assert.equal(calls.length, 3)
  for (const request of calls)
    for (const token of [firstGrant.token, grant.token, freshGrant.token])
      assert.ok(!JSON.stringify(request).includes(token), "a run token reached the upstream")
  console.log("gateway image: image user, session, second proof and restart passed")
  await gateway.stop()

  // Custody of a synthetic login in the image, against the fixture OAuth server and upstream.
  const custody = { credentialRole: "claude", login: { directory: loginDirectory(f) } }
  const outputs: string[] = []
  const old = claudeLogin(syntheticValue("access"), syntheticValue("refresh"), Date.now() + 30000)
  const next = oauth.next()
  const values = [
    old.claudeAiOauth.accessToken,
    old.claudeAiOauth.refreshToken,
    next.access,
    next.refresh,
  ]

  // A login directory of another owner is refused, by import-login and by the gateway.
  await mkdir(loginDirectory(f), { mode: 0o700 })
  const runnerUid = process.getuid!()
  const ownerFault = `custody refused ${loginDirectory(f)}: owner uid ${runnerUid}, custody requires uid ${imageUser}`
  const foreignImport = await imageCommand(
    f,
    custody,
    ["import-login", "claude"],
    JSON.stringify(old),
  )
  assert.deepEqual(foreignImport, {
    code: 1,
    stdout: "",
    stderr: `import-login refused: ${ownerFault}\n`,
  })
  const foreignStart = await imageCommand(f, custody, [])
  assert.notEqual(foreignStart.code, 0)
  assert.ok((foreignStart.stdout + foreignStart.stderr).includes(ownerFault), "no owner refusal")
  outputs.push(
    ...Object.values(foreignImport).map(String),
    foreignStart.stdout,
    foreignStart.stderr,
  )
  await rm(loginDirectory(f), { recursive: true })

  // import-login reads the login on standard input into a 0700 directory and a 0600 file of
  // the image's user.
  const importedLogin = await imageCommand(
    f,
    custody,
    ["import-login", "claude"],
    JSON.stringify(old),
  )
  assert.deepEqual(importedLogin, { code: 0, stdout: "imported the claude login\n", stderr: "" })
  outputs.push(importedLogin.stdout)
  const modes = await asImageUser(
    f,
    `const fs = require("node:fs"); const of = (p) => { const s = fs.statSync(p); return [s.uid, (s.mode & 0o777).toString(8)] }
process.stdout.write(JSON.stringify([of(${JSON.stringify(loginDirectory(f))}), of(${JSON.stringify(join(loginDirectory(f), "claude.json"))})]))`,
  )
  assert.equal(modes.code, 0, modes.stderr)
  assert.deepEqual(JSON.parse(modes.stdout), [
    [Number(imageUser), "700"],
    [Number(imageUser), "600"],
  ])

  // The noscope provider provider-access is custody, with the image's Bun and source.
  await writeCustodyProvider(
    f.root,
    loginDirectory(f),
    oauth.url,
    "/bin/bun",
    "/app/src/capability-gateway/custody.ts",
  )
  await chmod(join(f.root, "noscope/providers/provider-access.toml"), 0o640)
  const upstreamAt: number[] = []
  f.onUpstream(async () => {
    upstreamAt.push(performance.now())
  })
  const before = f.upstreamRequests().length

  // Two starts: the first renews once, before its upstream call; the second uses the stored login.
  for (const [index, jti] of ["jti-custody-1", "jti-custody-2"].entries()) {
    const custodian = await start(false, custody)
    const at = client(custodian.port)
    const challenge = await at.audience()
    const session = await at.session(proof(challenge.audience, jti))
    assert.equal(session.status, 200)
    const sessionText = await session.clone().text()
    const token = (await at.grant(session)).token
    const call = await at.call(token)
    const text = await call.text()
    assert.equal(call.status, 200)
    assert.equal(text, sse)
    outputs.push(sessionText, text, JSON.stringify([...call.headers]))
    await custodian.stop()
    outputs.push(custodian.output?.() ?? "")
    assert.equal(oauth.requests().length, 1, `renewals after start ${index + 1}`)
  }
  const renewalAt = oauth.requests()[0]?.at ?? Infinity
  assert.ok(renewalAt < (upstreamAt[0] ?? 0), "the renewal came after the upstream call")
  const custodyCalls = f.upstreamRequests().slice(before)
  assert.deepEqual(
    custodyCalls.map((request) => request.headers.authorization),
    [`Bearer ${next.access}`, `Bearer ${next.access}`],
  )
  assert.equal(
    JSON.parse(oauth.requests()[0]?.body ?? "{}").refresh_token,
    old.claudeAiOauth.refreshToken,
  )

  // A login directory with a wider mode is refused at start, by path and fault.
  const widened = await asImageUser(
    f,
    `require("node:fs").chmodSync(${JSON.stringify(loginDirectory(f))}, 0o750)`,
  )
  assert.equal(widened.code, 0, widened.stderr)
  const wideStart = await imageCommand(f, custody, [])
  assert.notEqual(wideStart.code, 0)
  assert.ok(
    (wideStart.stdout + wideStart.stderr).includes(
      `custody refused ${loginDirectory(f)}: mode 0750, custody requires 0700`,
    ),
    "no mode refusal",
  )
  outputs.push(wideStart.stdout, wideStart.stderr)

  // No value in an output of the image's processes, an answer, or the gateway's store.
  const store = await asImageUser(
    f,
    `const fs = require("node:fs"); const root = ${JSON.stringify(f.root)}
process.stdout.write(Buffer.concat(fs.readdirSync(root).filter((n) => /[.]db(-wal|-shm|-journal)?$/.test(n)).map((n) => fs.readFileSync(root + "/" + n))).toString("base64"))`,
  )
  assert.equal(store.code, 0, store.stderr)
  const storeText = Buffer.from(store.stdout, "base64").toString("latin1")
  assert.ok(storeText.length > 0, "the store was not read")
  const found = values
    .flatMap((value) => [
      value,
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
    ])
    .filter((form) => outputs.join("").includes(form) || storeText.includes(form))
  assert.deepEqual(found, [], "a login value left custody")
  console.log(
    `gateway image: custody refused a foreign owner and mode 0750, imported a login, and renewed it ${oauth.requests().length} time across two starts`,
  )
} finally {
  for (const gateway of gateways) await gateway.stop()
  await returnFixtureRoot(f)
  await oauth.stop()
  await f.close()
}
