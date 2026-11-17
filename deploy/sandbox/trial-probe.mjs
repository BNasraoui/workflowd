// The two probes of a private-mode runner job, which the first real run reports: whether the
// gateway's Service passes a body of the result route's bound, and whether the box's flags and
// network rules work on a hosted runner. Each probe prints one named line, of fixed words and
// numbers only, to the job's public log. A probe that fails does not fail the job: the run then
// shows the same fault at its own step.
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gatewayOrigin } from "./bootstrap-helper.mjs"
import { command } from "./command.mjs"

const tooling = dirname(fileURLToPath(import.meta.url))
/** The bound of a sealed result that the run client posts to the result route. */
export const resultBound = 16 * 1048576

/** One named line of a probe: `workflowd.probe <name>: <outcome>[ <detail>]`. */
export const probeLine = (name, outcome, detail = "") =>
  `workflowd.probe ${name}: ${outcome}${detail === "" ? "" : ` ${detail}`}`

/** The code of an error, of letters, digits and `_` only; `unknown` when it has none. */
const errorCode = (error) => {
  const code = error?.cause?.code ?? error?.code ?? error?.name
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "unknown"
}

/**
 * Posts a body of `size` bytes, with no run token, to the gateway's result route through the
 * Service. The gateway refuses a request with no token (403) before it reads the body, so the
 * probe counts the bytes that the request took from the body: `passed` is a 403 after the whole
 * body left the runner; `headers-only` a 403 before that, which shows that the Service forwards
 * the request but not that it takes the whole body; `refused` a 413 from the Service;
 * `inconclusive` any other answer. Only a post with a run token, which the result route reads,
 * shows the whole bound; this probe has none.
 */
export async function probeServiceBody({ gateway, send = fetch, size = resultBound }) {
  const name = "service-body-16mib"
  let sent = 0
  try {
    const url = `${gatewayOrigin(gateway)}/capabilities/v1/run/result`
    const chunk = new Uint8Array(65536)
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= size) return controller.close()
        const part = chunk.subarray(0, Math.min(chunk.length, size - sent))
        sent += part.length
        controller.enqueue(part)
      },
    })
    const response = await send(url, {
      method: "POST",
      body,
      duplex: "half",
      redirect: "error",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      signal: AbortSignal.timeout(120000),
    })
    await response.body?.cancel()
    const outcome =
      response.status === 403
        ? sent === size
          ? "passed"
          : "headers-only"
        : response.status === 413
          ? "refused"
          : "inconclusive"
    return probeLine(name, outcome, `status=${response.status} sent=${sent}`)
  } catch (error) {
    return probeLine(name, "failed", `error=${errorCode(error)} sent=${sent}`)
  }
}

/**
 * The destinations that the box's network drops, each by the reason of its rule in network.sh:
 * the cloud's metadata and its host agent, the tailnet's resolver, and the runner through the
 * box network's gateway.
 */
export const blockedDestinations = [
  { name: "metadata", host: "169.254.169.254", port: 80 },
  { name: "cloud-host", host: "168.63.129.16", port: 80 },
  { name: "tailnet", host: "100.100.100.100", port: 53 },
  { name: "runner", host: "172.30.0.1", port: 22 },
]

/**
 * In the box: connects to `host:port` for at most 3 s. Exit 0 when the packet was dropped (a
 * timeout or no route), 10 when the connection was made, 11 when the destination refused it.
 */
const connectScript = `import socket, sys
try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), 3).close()
    sys.exit(10)
except ConnectionRefusedError:
    sys.exit(11)
except OSError:
    sys.exit(0)`

/** The line of the network probe from the destinations that the box reached. */
export const networkLine = (reached) =>
  reached.length === 0
    ? probeLine("box-network", "passed", `dropped=${blockedDestinations.length}`)
    : probeLine("box-network", "failed", `reached=${reached.join(",")}`)

/**
 * Starts a box of the job's `image` with the flags of a run's box (native-docker.mjs), on the
 * run's network with its rules (network.sh host), and tries each blocked destination from it.
 * It removes the box, the network and the rules that it made, so the run's own harness makes them
 * anew; it removes nothing that it did not make.
 */
export async function probeBox({ image, sudo = "/usr/bin/sudo", box: boxModule }) {
  // The box of a run (native-docker.mjs), unless a test names its own.
  const { boxNetwork, docker: run, makeBox } = boxModule ?? (await import("./native-docker.mjs"))
  const lines = []
  const directory = await mkdtemp(join(tmpdir(), "wfd-probe-"))
  // The box mounts the relay's socket; the probe's own listener stands in for it.
  const socket = createServer()
  await new Promise((resolve, reject) =>
    socket.once("error", reject).listen(join(directory, "gateway.sock"), resolve),
  )
  let box
  let step = "binding"
  // What the probe made, which it alone removes.
  const made = { network: false, rules: false, box: false }
  try {
    box = makeBox({ directory, image, name: `workflowd-native-${"0".repeat(32)}` })
    // The pull, the long step, comes before the probe makes anything: a time limit of the step
    // that ends the probe during the pull leaves no network and no rules for the run's harness.
    step = "image"
    await run("image", ["image", "pull", "--quiet", image], { timeoutMs: 900000 })
    step = "network"
    await run("network", [
      "network", "create", "--subnet", boxNetwork.subnet,
      "-o", "com.docker.network.bridge.name=wfd-sandbox0", boxNetwork.name,
    ])
    made.network = true
    step = "network rules"
    made.rules = true
    await command("network rules", sudo, [
      "-n", "/bin/bash", join(tooling, "network.sh"), "host", boxNetwork.subnet,
    ])
    step = "box"
    made.box = true
    await box.start()
    lines.push(probeLine("box-flags", "passed"))
    const reached = []
    for (const destination of blockedDestinations) {
      try {
        await box.exec("connect", [
          "/bin/python3", "-c", connectScript, destination.host, String(destination.port),
        ])
      } catch {
        reached.push(destination.name)
      }
    }
    lines.push(networkLine(reached))
  } catch {
    lines.push(probeLine("box-flags", "failed", `step=${step.replace(" ", "-")}`))
  } finally {
    if (made.box) await box?.remove().catch(() => undefined)
    if (made.network)
      await run("network remove", ["network", "rm", boxNetwork.name]).catch(() => undefined)
    if (made.rules)
      await command("network stop", sudo, [
        "-n", "/bin/bash", join(tooling, "network.sh"), "stop",
      ]).catch(() => undefined)
    socket.close()
    await rm(directory, { recursive: true, force: true })
  }
  return lines
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = [
    await probeServiceBody({ gateway: process.env.SANDBOX_GATEWAY_URL ?? "" }),
    ...(await probeBox({ image: process.env.SANDBOX_AGENT_IMAGE ?? "" }).catch(() => [
      probeLine("box-flags", "failed", "step=probe"),
    ])),
  ]
  for (const line of lines) process.stdout.write(`${line}\n`)
}
