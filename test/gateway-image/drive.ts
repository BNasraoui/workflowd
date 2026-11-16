import "../resources/preload"
import { strict as assert } from "node:assert"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { loopbackCertificate } from "../helpers/loopback-tls"
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
 * noscope. Each gateway container runs as the image's own user, on Docker's default bridge for
 * its calls to the fixture servers, which listen on the bridge's address of this host; it
 * publishes no port. Its listener is a Unix socket in a volume, a directory of this host, that it
 * shares with the front container and with no other: the front runs the test front of
 * test/helpers/loopback-tls.ts as the front's user and publishes one port, through which each
 * client of this test reaches the gateway. This process is workflowd: it grants the fixture run on the gateway's control socket,
 * which the container serves for the runner's uid and group.
 */
const image = "workflowd-gateway:local"
const imageUser = "10001"
/** The front's uid and gid; a uid outside its group; another uid of its group. */
const frontId = "10002"
const outsiderId = "10003"
const groupMemberId = "10004"
/** Where the volume of the listener's directory is in each container that has it. */
const volumeMount = "/run/workflowd-gateway"
const listenSocket = `${volumeMount}/front/gateway.sock`
/** The port of the front in its container, which it publishes on this host's loopback. */
const frontPort = 8443
/**
 * Docker's default bridge. A network that a user makes has Docker's resolver in each container's
 * namespace, with a TCP listener on 127.0.0.11; the default bridge has none, so each TCP listener
 * in the gateway container's namespace is the gateway's.
 */
const network = "bridge"
/** The listener's volume: a directory of this host, which Docker does not copy anything into. */
const volume = join(tmpdir(), `workflowd-gateway-listener-${process.pid}`)
let started = 0

/** A docker command; its output, or a failure that names the command. */
async function docker(args: ReadonlyArray<string>) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr}`)
  return stdout.trim()
}

/** Waits until the output of the container `name` holds `line`. */
async function logged(name: string, line: string) {
  for (let tries = 0; tries < 300; tries++) {
    const logs = Bun.spawn(["docker", "logs", name], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(logs.stdout).text(),
      new Response(logs.stderr).text(),
    ])
    await logs.exited
    if (`${stdout}\n${stderr}`.split("\n").includes(line)) return
    await Bun.sleep(100)
  }
  throw new Error(`${name} did not log ${line}`)
}

/** The flags that each container of this test has: no new privilege, no capability. */
const lockedDown = [
  "--read-only",
  "--tmpfs",
  "/tmp",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
]

/**
 * The front's container, on the gateway's bridge: the image's Bun runs the test front as the
 * front's uid and gid, with the listener's volume, the front's certificate, and the port that it
 * publishes on this host's loopback. A client reaches the gateway at `origin`, trusting `ca`.
 */
async function startFront(tls: { key: string; cert: string }) {
  const name = `workflowd-gateway-front-${process.pid}`
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--network",
    network,
    ...lockedDown,
    "--user",
    `${frontId}:${frontId}`,
    "--volume",
    `${volume}:${volumeMount}`,
    "--volume",
    `${resolve("test/helpers/loopback-tls.ts")}:/front/loopback-tls.ts:ro`,
    "--volume",
    `${dirname(tls.key)}:/front/tls:ro`,
    "--publish",
    `127.0.0.1::${frontPort}`,
    "--entrypoint",
    "/bin/bun",
    image,
    "-e",
    `import { tlsFront } from "/front/loopback-tls.ts"
await tlsFront({ key: "/front/tls/${basename(tls.key)}", cert: "/front/tls/${basename(tls.cert)}" }, ${JSON.stringify(listenSocket)}, {}, { host: "0.0.0.0", port: ${frontPort} })
console.log("listening")`,
  ])
  await logged(name, "listening")
  const port = /:(\d+)$/.exec(await docker(["port", name, `${frontPort}/tcp`]))?.[1]
  if (port === undefined) throw new Error("the front publishes no port")
  return {
    name,
    origin: `https://127.0.0.1:${port}`,
    service: `127.0.0.1:${port}`,
    ca: await readFile(tls.cert, "utf8"),
    stop: () => docker(["rm", "--force", name]),
  }
}
type FrontContainer = Awaited<ReturnType<typeof startFront>>

/**
 * A container of the image with `options`: on `network` (none unless named), as `user` (the
 * image's unless named), with the listener's volume when `volume` holds and each of `mounts`;
 * the image's Bun runs `source`. Its standard output, standard error and exit code.
 */
async function probe(
  source: string,
  options: {
    readonly network?: string
    readonly user?: string
    readonly volume?: boolean
    readonly mounts?: ReadonlyArray<string>
  } = {},
) {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      options.network ?? "none",
      ...lockedDown,
      ...(options.user === undefined ? [] : ["--user", options.user]),
      ...(options.volume ? ["--volume", `${volume}:${volumeMount}`] : []),
      ...(options.mounts ?? []).flatMap((mount) => ["--volume", mount]),
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

/** The TCP listen entries (state 0A) of the network namespace of the container `name`. */
async function listenEntries(name: string) {
  return JSON.parse(
    await docker([
      "exec",
      name,
      "/bin/bun",
      "-e",
      `const fs = require("node:fs"); const out = []
for (const t of ["tcp", "tcp6"]) for (const l of fs.readFileSync("/proc/self/net/" + t, "utf8").split("\\n").slice(1)) { const f = l.trim().split(/\\s+/); if (f[3] === "0A") out.push(t + " " + f[1]) }
process.stdout.write(JSON.stringify(out))`,
    ]),
  ) as unknown
}

/**
 * A request for a challenge on the listener's socket, with the headers of the front, from a
 * container as `user` with the listener's volume. `stat` is `ok`, or the error of a stat of the
 * socket; `call` is what `unixCall` of test/helpers/unix-call.ts gives.
 */
async function socketCall(user: string, service: string) {
  const request = `GET /capabilities/v1/challenge?lease=lease HTTP/1.1\r\nhost: localhost\r\nx-forwarded-for: 100.64.0.7\r\nx-forwarded-proto: https\r\nx-forwarded-host: ${service}\r\nconnection: close\r\n\r\n`
  const result = await probe(
    `import { unixCall } from "/probe/unix-call.ts"
let stat = "ok"
try { require("node:fs").statSync(${JSON.stringify(listenSocket)}) } catch (error) { stat = error.code }
process.stdout.write(JSON.stringify({ stat, call: unixCall(${JSON.stringify(listenSocket)}, ${JSON.stringify(request)}) }))`,
    {
      user,
      volume: true,
      mounts: [`${resolve("test/helpers/unix-call.ts")}:/probe/unix-call.ts:ro`],
    },
  )
  if (result.code !== 0) throw new Error(`the call as ${user} failed: ${result.stderr}`)
  return JSON.parse(result.stdout) as unknown
}

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
    f.root,
    `require("node:fs").chownSync(${JSON.stringify(f.root)}, ${imageUser}, ${runnerGroup()})`,
  )
}

/** A container of the image as root, which may change the owner of a path below `root`. */
async function asRoot(root: string, source: string) {
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
      `${root}:${root}`,
      "--entrypoint",
      "/bin/bun",
      image,
      "-e",
      source,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  if ((await child.exited) !== 0) throw new Error(`a container as root failed on ${root}`)
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
      'const fs = require("node:fs"); process.stdout.write(fs.readFileSync("/proc/1/status", "utf8") + fs.readFileSync("/proc/1/limits", "utf8"))',
    ],
    { stdout: "pipe", stderr: "inherit" },
  )
  const status = await new Response(read.stdout).text()
  if ((await read.exited) !== 0) throw new Error(`cannot read the gateway's ids in ${name}`)
  const field = (key: string) =>
    new RegExp(`^${key}:(.*)$`, "m").exec(status)?.[1]?.trim().split(/\s+/) ?? []
  const core = /^Max core file size\s+(\S+)\s+(\S+)/m.exec(status)
  return {
    uid: field("Uid"),
    gid: field("Gid"),
    groups: field("Groups"),
    core: [core?.[1], core?.[2]],
  }
}

/**
 * A container of the image on the gateway's bridge, with the listener's volume and the fixture
 * root, behind `front`. `entrypoint` runs the image's own command; else the image's Bun runs the
 * same server with the fixture's key server and upstream, as the gateway process of the session
 * tests does. No `--user` replaces the image's user. With `oauthPort`, a second container in the
 * gateway's network namespace forwards that port of its loopback to the same port of the bridge's
 * address of this host, where the fixture OAuth server is: custody takes a plain HTTP token URL
 * on loopback only.
 */
async function imageGateway(
  f: Fixture,
  front: FrontContainer,
  entrypoint: boolean,
  custody: object = {},
  oauthPort?: number,
): Promise<Gateway & { readonly name: string }> {
  const name = `workflowd-gateway-image-${process.pid}-${++started}`
  const forwarder = `${name}-oauth`
  const group = runnerGroup()
  const config = imageConfig(f, front.service, custody)
  const removed = async () => {
    for (const container of [forwarder, name])
      await Bun.spawn(["docker", "rm", "--force", container], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited
  }
  const container = await startGatewayProcess(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      network,
      ...lockedDown,
      "--group-add",
      group,
      // The gateway gives the listener's directory the front's group.
      "--group-add",
      frontId,
      "--volume",
      `${f.root}:${f.root}`,
      "--volume",
      `${volume}:${volumeMount}`,
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
    front,
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
    // The gateway writes no core file, nor does a process it starts: they inherit the limit.
    assert.deepEqual(ids.core, ["0", "0"], "the gateway's core file limit is not 0")
    if (oauthPort !== undefined) {
      await docker([
        "run",
        "--detach",
        "--rm",
        "--name",
        forwarder,
        "--network",
        `container:${name}`,
        ...lockedDown,
        "--entrypoint",
        "/bin/bun",
        image,
        "-e",
        `const net = require("node:net")
net.createServer((client) => {
  const server = net.connect(${oauthPort}, ${JSON.stringify(bridge)})
  client.on("error", () => server.destroy())
  server.on("error", () => client.destroy())
  client.pipe(server).pipe(client)
}).listen(${oauthPort}, "127.0.0.1", () => console.log("forwarding"))`,
      ])
      await logged(forwarder, "forwarding")
    }
  } catch (error) {
    await stop()
    throw error
  }
  await f.reconcile().catch(async (error: unknown) => {
    await stop()
    throw error
  })
  return { ...container, name, stop }
}

/** The listen section of the gateway in the image, behind the front of the Service `service`. */
const imageListen = (service: string) => ({
  socket: listenSocket,
  front: { uid: Number(frontId), gid: Number(frontId) },
  service,
})

/**
 * The gateway's configuration in the image, behind the front of the Service `service`; `custody`
 * adds the login that custody holds, or replaces a key.
 */
const imageConfig = (f: Fixture, service: string, custody: object = {}) => ({
  ...f.config,
  noscope: { binary: "/bin/noscope", configHome: f.root },
  daemon: { uid: process.getuid!(), gid: Number(runnerGroup()) },
  listen: imageListen(service),
  ...custody,
})

/** The flags of each container of the image, as Phase 1 runs it. */
const containerFlags = (f: Fixture) => [
  ...lockedDown,
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
 * configuration with custody, behind the front of the Service `service`: `import-login`, or a
 * start that the configuration or custody refuses. It has no network, and the listener's volume.
 */
async function imageCommand(
  f: Fixture,
  service: string,
  custody: object,
  args: ReadonlyArray<string>,
  input?: string,
  user?: string,
) {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      ...containerFlags(f),
      "--volume",
      `${volume}:${volumeMount}`,
      ...(user === undefined ? [] : ["--user", user]),
      "--env",
      "WORKFLOWD_CAPABILITY_GATEWAY",
      image,
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(imageConfig(f, service, custody)),
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
    f.root,
    `const fs = require("node:fs"); const walk = (path) => { fs.lchownSync(path, ${process.getuid!()}, ${runnerGroup()}); if (fs.lstatSync(path).isDirectory()) for (const name of fs.readdirSync(path)) walk(path + "/" + name) }
walk(${JSON.stringify(f.root)}); fs.chmodSync(${JSON.stringify(f.root)}, 0o700)`,
  )
}

const loginDirectory = (f: Fixture) => join(f.root, "login")

// The address of this host on the bridge, where the fixture servers listen.
const bridge = await docker([
  "network",
  "inspect",
  "--format",
  "{{(index .IPAM.Config 0).Gateway}}",
  network,
])
await mkdir(volume, { mode: 0o755 })
const f = await fixture({}, bridge)
const oauth = oauthFixture(bridge)
const tlsDirectory = await mkdtemp(join(tmpdir(), "wfd-front-tls-"))
const gateways: Gateway[] = []
let front: FrontContainer | undefined
try {
  await fixtureForImageUser(f)
  // The volume's root is the gateway's user's, as a deployment gives it: the gateway makes the
  // listener's directory in it, with the front's group.
  await asRoot(
    volume,
    `require("node:fs").chownSync(${JSON.stringify(volume)}, ${imageUser}, ${imageUser})`,
  )
  // The front's certificate, which its user reads.
  await chmod(tlsDirectory, 0o755)
  const tls = await loopbackCertificate(tlsDirectory)
  for (const path of [tls.key, tls.cert]) await chmod(path, 0o644)

  // The image's own command with a host in its listen section exits with the fixed error, and
  // makes nothing in the listener's volume.
  const withHost = await imageCommand(
    f,
    "gateway.example.ts.net",
    {
      listen: { ...imageListen("gateway.example.ts.net"), host: "127.0.0.1" },
    },
    [],
  )
  assert.notEqual(withHost.code, 0)
  assert.match(
    withHost.stdout + withHost.stderr,
    /Expected no excess property\s+at \["listen"\]\["host"\]/,
  )
  const volumeEntries = await probe(
    `process.stdout.write(JSON.stringify(require("node:fs").readdirSync(${JSON.stringify(volumeMount)})))`,
    { volume: true },
  )
  assert.deepEqual(JSON.parse(volumeEntries.stdout), [], "the refused start made an entry")
  console.log("gateway image: a listen section with a host is refused with the fixed error")

  front = await startFront(tls)
  const frontContainer = front
  const start = async (entrypoint = false, custody: object = {}, oauthPort?: number) => {
    const gateway = await imageGateway(f, frontContainer, entrypoint, custody, oauthPort)
    gateways.push(gateway)
    return gateway
  }

  // The image's own command migrates the store, listens and issues a challenge.
  const own = await start(true)
  const ownChallenge = await client(own).challenge("lease")
  assert.equal(ownChallenge.status, 200)
  await own.stop()

  let gateway = await start()
  const at = () => client(gateway)

  // The gateway container publishes no port, and its network namespace holds no TCP socket in
  // the listen state; the same reads of the front's container find its published port.
  assert.equal(await docker(["port", gateway.name]), "", "the gateway publishes a port")
  assert.match(await docker(["port", frontContainer.name]), new RegExp(`^${frontPort}/tcp -> `))
  assert.deepEqual(await listenEntries(gateway.name), [], "the gateway's namespace listens on TCP")
  assert.deepEqual(await listenEntries(frontContainer.name), [
    `tcp 00000000:${frontPort.toString(16).toUpperCase()}`,
  ])
  // A container on the same bridge, without the volume, reaches no port of the gateway and has
  // no socket of it; it reaches the front's port.
  const address = (name: string) =>
    docker([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
      name,
    ])
  const reach = await probe(
    `const net = require("node:net")
const connect = (host, port) => new Promise((done) => {
  const socket = net.connect(port, host)
  const timer = setTimeout(() => { socket.destroy(); done("timeout") }, 3000)
  socket.on("connect", () => { clearTimeout(timer); socket.destroy(); done("open") })
  socket.on("error", (error) => { clearTimeout(timer); done(error.code) })
})
const gateway = {}
for (const port of [80, 443, 8080, 8443, 8787]) gateway[port] = await connect(${JSON.stringify(await address(gateway.name))}, port)
process.stdout.write(JSON.stringify({ gateway, front: await connect(${JSON.stringify(await address(frontContainer.name))}, ${frontPort}), socket: require("node:fs").existsSync(${JSON.stringify(listenSocket)}) }))`,
    { network },
  )
  assert.equal(reach.code, 0, reach.stderr)
  assert.deepEqual(JSON.parse(reach.stdout), {
    gateway: Object.fromEntries([80, 443, 8080, 8443, 8787].map((port) => [port, "ECONNREFUSED"])),
    front: "open",
    socket: false,
  })
  // With the volume: a uid outside the front's group may not enter the listener's directory and
  // cannot connect; a uid of the group that is not the front's is ended at accept; the front's
  // uid is answered.
  assert.deepEqual(await socketCall(`${outsiderId}:${outsiderId}`, frontContainer.service), {
    stat: "EACCES",
    call: "error EACCES",
  })
  assert.deepEqual(await socketCall(`${groupMemberId}:${frontId}`, frontContainer.service), {
    stat: "ok",
    call: "ended",
  })
  assert.deepEqual(await socketCall(`${frontId}:${frontId}`, frontContainer.service), {
    stat: "ok",
    call: "HTTP/1.1 200 OK",
  })
  console.log(
    "gateway image: no published port and no TCP listener; a bridge peer without the volume, a uid outside the group and a uid of the group that is not the front's do not reach a route",
  )

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

  // The noscope provider provider-access is custody, with the image's Bun and source.
  await writeCustodyProvider(
    f.root,
    loginDirectory(f),
    // Custody reaches the fixture OAuth server on the gateway's loopback, through the forwarder.
    `http://127.0.0.1:${oauth.port}/v1/oauth/token`,
    "/bin/bun",
    "/app/src/capability-gateway/custody-process.ts",
  )
  await chmod(join(f.root, "noscope/providers/provider-access.toml"), 0o640)

  // import-login as root is refused, and makes no directory.
  const rootImport = await imageCommand(
    f,
    frontContainer.service,
    custody,
    ["import-login", "claude"],
    JSON.stringify(old),
    "0",
  )
  assert.deepEqual(rootImport, {
    code: 1,
    stdout: "",
    stderr: "import-login refused: import-login runs as the gateway's user, not as root\n",
  })
  await assert.rejects(readdir(loginDirectory(f)), "import-login as root made the directory")

  // A login directory of another owner is refused, by import-login and by the gateway.
  await mkdir(loginDirectory(f), { mode: 0o700 })
  const runnerUid = process.getuid!()
  const ownerFault = `custody refused ${loginDirectory(f)}: owner uid ${runnerUid}, custody requires uid ${imageUser}`
  const foreignImport = await imageCommand(
    f,
    frontContainer.service,
    custody,
    ["import-login", "claude"],
    JSON.stringify(old),
  )
  assert.deepEqual(foreignImport, {
    code: 1,
    stdout: "",
    stderr: `import-login refused: ${ownerFault}\n`,
  })
  const foreignStart = await imageCommand(f, frontContainer.service, custody, [])
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
    frontContainer.service,
    custody,
    ["import-login", "claude"],
    JSON.stringify(old),
  )
  assert.deepEqual(importedLogin, {
    code: 0,
    stdout: `imported the claude login, owned by uid ${imageUser}\n`,
    stderr: "",
  })
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

  const upstreamAt: number[] = []
  f.onUpstream(async () => {
    upstreamAt.push(performance.now())
  })
  const before = f.upstreamRequests().length

  // Two starts: the first renews once, before its upstream call; the second uses the stored login.
  for (const [index, jti] of ["jti-custody-1", "jti-custody-2"].entries()) {
    const custodian = await start(false, custody, oauth.port)
    const at = client(custodian)
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
  const wideStart = await imageCommand(f, frontContainer.service, custody, [])
  assert.notEqual(wideStart.code, 0)
  assert.ok(
    (wideStart.stdout + wideStart.stderr).includes(
      `custody refused ${loginDirectory(f)}: mode 0750, custody requires 0700`,
    ),
    "no mode refusal",
  )
  outputs.push(wideStart.stdout, wideStart.stderr)

  // No value in an output of the image's processes, an answer, or the gateway's store. First,
  // a value put there on purpose: an output of import-login, and a store file.
  const plantedOutput = syntheticValue("planted")
  const plantedImport = await imageCommand(
    f,
    frontContainer.service,
    custody,
    ["import-login", plantedOutput],
    "",
  )
  assert.equal(plantedImport.code, 1)
  outputs.push(plantedImport.stdout, plantedImport.stderr)
  const plantedStore = syntheticValue("planted")
  await writeFile(join(f.root, "planted.db"), plantedStore, { mode: 0o644 })
  const store = await asImageUser(
    f,
    `const fs = require("node:fs"); const root = ${JSON.stringify(f.root)}
process.stdout.write(Buffer.concat(fs.readdirSync(root).filter((n) => /[.]db(-wal|-shm|-journal)?$/.test(n)).map((n) => fs.readFileSync(root + "/" + n))).toString("base64"))`,
  )
  assert.equal(store.code, 0, store.stderr)
  const storeText = Buffer.from(store.stdout, "base64").toString("latin1")
  assert.ok(storeText.length > 0, "the store was not read")
  const search = (value: string) =>
    [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")].filter(
      (form) => outputs.join("").includes(form) || storeText.includes(form),
    )
  // The search finds a value put on purpose in an output and in the store files.
  assert.deepEqual(search(plantedOutput), [plantedOutput], "the search missed an output value")
  assert.deepEqual(search(plantedStore), [plantedStore], "the search missed a store value")
  const found = values.flatMap(search)
  assert.deepEqual(found, [], "a login value left custody")
  console.log(
    `gateway image: custody refused a foreign owner and mode 0750, imported a login, and renewed it ${oauth.requests().length} time across two starts`,
  )
} finally {
  for (const gateway of gateways) await gateway.stop()
  await front?.stop()
  await returnFixtureRoot(f)
  await oauth.stop()
  await f.close()
  // What the image's users made in the volume goes, and the volume goes back to the runner.
  await asRoot(
    volume,
    `const fs = require("node:fs"); for (const name of fs.readdirSync(${JSON.stringify(volume)})) fs.rmSync(${JSON.stringify(volume)} + "/" + name, { recursive: true, force: true })
fs.chownSync(${JSON.stringify(volume)}, ${process.getuid!()}, ${process.getgid!()})`,
  )
  await rm(volume, { recursive: true, force: true })
  await rm(tlsDirectory, { recursive: true, force: true })
}
