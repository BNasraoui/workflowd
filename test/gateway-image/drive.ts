import "../resources/preload"
import { strict as assert } from "node:assert"
import { chmod, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  client,
  fixture,
  proof,
  sse,
  type Fixture,
  type Gateway,
} from "../capability-gateway/gateway-process"

/**
 * The gateway image under Docker, against the session fixtures. The preload holds the run under
 * the test resource guard, as test/resources/run.ts does: the fixture's store, noscope
 * providers, key server and model upstream, with the image's own Bun, modules and noscope.
 * Each container runs as the image's own user.
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
 * The image's user reaches the fixture through the runner's group: it writes the store, the mint
 * records and their directories, and reads the noscope providers, which noscope accepts with
 * group read and no access for others. The providers start their scripts with the image's Bun.
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
  const config = { ...f.config, noscope: { binary: "/bin/noscope", configHome: f.root } }
  const group = runnerGroup()
  const inject = `import { runCapabilityGatewayServer } from "/app/src/capability-gateway-server.ts"
import { Effect } from "effect"
Effect.runFork(runCapabilityGatewayServer(process.env, {
  keys: async (signal) => (await fetch(${JSON.stringify(f.keysUrl)}, { signal })).json(),
  upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", ${JSON.stringify(f.upstreamUrl)}), init),
}))`
  const child = Bun.spawn(
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
      "WORKFLOWD_DATABASE_PATH",
      "--env",
      "WORKFLOWD_CAPABILITY_GATEWAY",
      ...(entrypoint ? [image] : ["--entrypoint", "/bin/bun", image, "-e", inject]),
    ],
    {
      env: {
        PATH: process.env.PATH,
        WORKFLOWD_DATABASE_PATH: f.env.WORKFLOWD_DATABASE_PATH,
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  )
  const stop = async () => {
    await Bun.spawn(["docker", "rm", "--force", name], { stdout: "ignore", stderr: "ignore" })
      .exited
    await child.exited
  }
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const part = await reader.read()
    if (part.done) throw new Error(`gateway container ${name} exited before listening`)
    text += Buffer.from(part.value).toString()
  }
  reader.releaseLock()
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
  return { port: Number(/^listening (\d+)$/m.exec(text)?.[1]), stop }
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
  await f.close()
}
