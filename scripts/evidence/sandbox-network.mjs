import * as Bun from "bun"
import assert from "node:assert/strict"
import { isIP } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

// ss output is collected immediately before and after the probe, never a port sample.
export function denialTargets(inventory) {
  for (const role of ["mint", "peer", "second-runner"])
    assert.ok(
      inventory.some((host) => host.role === role),
      `Missing ${role} inventory`,
    )
  const addresses = new Set()
  return inventory.flatMap(({ address, listeners }) => {
    assert.ok(isIP(address) && !addresses.has(address), "Invalid or duplicate inventory address")
    addresses.add(address)
    const ports = new Set()
    for (const line of listeners.trim().split("\n")) {
      const fields = line.trim().split(/\s+/)
      const port = Number(fields[3]?.match(/:(\d+)$/)?.[1])
      assert.ok(fields[0] === "LISTEN" && port > 0 && port <= 65535, "Invalid listener inventory")
      ports.add(port)
    }
    return [...ports].sort((a, b) => a - b).map((port) => ({ host: address, port }))
  })
}

export function assertProbeResults(targets, results, expected) {
  assert.deepEqual(
    results.map(({ host, port }) => ({ host, port })),
    targets,
  )
  assert.ok(
    results.every(({ result }) => expected.split("|").includes(result)),
    "Unexpected network result",
  )
}

export async function executeProbe(args, script = "", timeout = 30000) {
  const child = Bun.spawn(args, {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
  try {
    const [status, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
    assert.equal(status, 0, "Network evidence command failed")
    return text.trim()
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}

export async function collectListeners(hosts, runnerAddress) {
  const status = JSON.parse(await executeProbe(["tailscale", "status", "--json"]))
  // Require the full controller-visible tailnet, including the supplied second runner.
  const peers = [status.Self, ...Object.values(status.Peer ?? {})]
  const addresses = peers
    .flatMap((peer) => peer.TailscaleIPs.filter((address) => isIP(address) === 4))
    .filter((address) => address !== runnerAddress)
  assert.deepEqual(
    hosts.map((host) => host.address).sort(),
    addresses.sort(),
    "Tailnet inventory is incomplete",
  )
  const inventory = []
  for (const host of hosts) {
    assert.ok(isIP(host.address), "Inventory must use literal IP addresses")
    if (host.role === "mint") assert.ok(status.Self.TailscaleIPs.includes(host.address))
    if (host.role === "second-runner") {
      const peer = peers.find((peer) => peer.TailscaleIPs.includes(host.address))
      assert.ok(peer?.Tags?.includes("tag:agent-runner"), "Second runner identity is unconfirmed")
    }
    const args =
      host.role === "mint"
        ? ["ss", "-H", "-ltn"]
        : [
            "ssh",
            "-F",
            "/dev/null",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            `UserKnownHostsFile=${host.knownHostsFile}`,
            "-i",
            host.identityFile,
            "-l",
            host.login,
            host.address,
            "exec ss -H -ltn",
          ]
    inventory.push({ role: host.role, address: host.address, listeners: await executeProbe(args) })
  }
  return inventory
}

export function connectionScript(targets) {
  return `import concurrent.futures,json,socket,time
# Bounded concurrency keeps the complete listener inventory practical.
targets=json.loads(${JSON.stringify(JSON.stringify(targets))})
def probe(target):
 start=time.monotonic()
 try:
  with socket.create_connection((target['host'],target['port']),timeout=3): pass
  result='connected'
 except TimeoutError: result='timeout'
 except ConnectionRefusedError: result='refused'
 except OSError: result='other_error'
 return dict(target,result=result,seconds=round(time.monotonic()-start,3))
with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
 print(json.dumps(list(pool.map(probe,targets))))`
}

export async function probeDagger(ssh, script, timeout) {
  const client = new Client({ name: "workflowd-network-evidence", version: "1" })
  const transport = new StdioClientTransport({
    command: ssh[0],
    args: ssh.slice(1),
    stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  const timer = setTimeout(() => {
    void client.close()
  }, timeout)
  const call = async (name, args) => {
    const result = await client.callTool(
      { name, arguments: { environment_source: "/workspace/repository", ...args } },
      undefined,
      { timeout },
    )
    assert.ok(!result.isError, "Dagger network probe failed")
    return result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  }
  try {
    await client.connect(transport)
    const { id } = JSON.parse(
      // container-use may append a warning about controller-owned config.
      (await call("environment_create", { title: "Network denial evidence" })).split("\n")[0],
    )
    assert.equal(typeof id, "string")
    const encoded = Buffer.from(script).toString("base64")
    const text = await call("environment_run_cmd", {
      environment_id: id,
      command: `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`,
    })
    // container-use surrounds stdout with its command log; use a dedicated marker.
    const match = text.match(/WORKFLOWD_NETWORK=(\[[^\n]+\])/)
    assert.ok(match, "Dagger network results missing")
    return JSON.parse(match[1])
  } finally {
    clearTimeout(timer)
    await client.close()
  }
}
