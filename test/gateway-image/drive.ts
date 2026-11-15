import "../resources/preload"
import { strict as assert } from "node:assert"
import { readFile, writeFile } from "node:fs/promises"
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
 */
const image = process.argv[2] ?? "workflowd-gateway:local"
const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0
let started = 0

/** The fixture's noscope providers start their scripts with the image's Bun. */
async function providersInImage(f: Fixture) {
  for (const name of ["run-capability", "provider-access"]) {
    const path = join(f.root, `noscope/providers/${name}.toml`)
    await writeFile(path, (await readFile(path, "utf8")).replaceAll(process.execPath, "/bin/bun"), {
      mode: 0o600,
    })
  }
}

/**
 * A container of the image on the host network. `entrypoint` runs the image's own command; else
 * the image's Bun runs the same server with the fixture's key server and upstream, as the gateway
 * process of the session tests does.
 */
async function imageGateway(f: Fixture, entrypoint: boolean): Promise<Gateway> {
  const name = `workflowd-gateway-image-${process.pid}-${++started}`
  const config = { ...f.config, noscope: { binary: "/bin/noscope", configHome: f.root } }
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
      "--user",
      `${uid}:${gid}`,
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
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const part = await reader.read()
    if (part.done) throw new Error(`gateway container ${name} exited before listening`)
    text += Buffer.from(part.value).toString()
  }
  reader.releaseLock()
  return {
    port: Number(/^listening (\d+)$/m.exec(text)?.[1]),
    stop: async () => {
      await Bun.spawn(["docker", "rm", "--force", name], { stdout: "ignore", stderr: "ignore" })
        .exited
      await child.exited
    },
  }
}

const f = await fixture()
const gateways: Gateway[] = []
const start = async (entrypoint = false) => {
  const gateway = await imageGateway(f, entrypoint)
  gateways.push(gateway)
  return gateway
}
try {
  await providersInImage(f)

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
  const replayed = await at().session(proof((await at().audience()).audience, "jti-2"))
  assert.equal(replayed.status, 403)
  assert.equal((await at().call(firstGrant.token)).status, 403)

  // The upstream saw each allowed call, and never a run token.
  const calls = f.upstreamRequests()
  assert.equal(calls.length, 3)
  for (const request of calls)
    for (const token of [firstGrant.token, grant.token])
      assert.ok(!JSON.stringify(request).includes(token), "a run token reached the upstream")
  console.log("gateway image: session, second proof and restart passed")
} finally {
  for (const gateway of gateways) await gateway.stop()
  await f.close()
}
