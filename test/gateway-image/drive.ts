import "../resources/preload"
import { strict as assert } from "node:assert"
import { chmod, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  client,
  fixture,
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
 * The image's user reaches the fixture through the runner's group: it writes its store, makes its
 * control directory, writes the mint records and their directories, and reads the noscope
 * providers, which noscope accepts with group read and no access for others. The providers start
 * their scripts with the image's Bun.
 */
async function fixtureForImageUser(f: Fixture) {
  for (const name of ["run-capability", "provider-access"]) {
    const path = join(f.root, `noscope/providers/${name}.toml`)
    await writeFile(path, (await readFile(path, "utf8")).replaceAll(process.execPath, "/bin/bun"))
    await chmod(path, 0o640)
  }
  for (const directory of ["noscope", "noscope/providers"])
    await chmod(join(f.root, directory), 0o750)
  for (const directory of [".", "live"]) await chmod(join(f.root, directory), 0o770)
  for (const entry of await readdir(f.root, { withFileTypes: true }))
    if (entry.isFile()) await chmod(join(f.root, entry.name), 0o660)
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
async function imageGateway(f: Fixture, entrypoint: boolean): Promise<Gateway> {
  const name = `workflowd-gateway-image-${process.pid}-${++started}`
  const group = runnerGroup()
  const config = {
    ...f.config,
    noscope: { binary: "/bin/noscope", configHome: f.root },
    daemon: { uid: process.getuid!(), gid: Number(group) },
  }
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

/**
 * The gateway's control directory is the image user's, mode 0710, so the runner cannot remove the
 * socket in it. A container of the image, as that user, removes the directory.
 */
async function removeControlDirectory(f: Fixture) {
  const removal = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--group-add",
      runnerGroup(),
      "--volume",
      `${f.root}:${f.root}`,
      "--entrypoint",
      "/bin/bun",
      image,
      "-e",
      `require("node:fs").rmSync(${JSON.stringify(dirname(f.config.controlSocket))}, { recursive: true, force: true })`,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  if ((await removal.exited) !== 0) throw new Error("cannot remove the gateway's control directory")
}

const f = await fixture()
const gateways: Gateway[] = []
const start = async (entrypoint = false) => {
  const gateway = await imageGateway(f, entrypoint)
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
} finally {
  for (const gateway of gateways) await gateway.stop()
  await removeControlDirectory(f)
  await f.close()
}
