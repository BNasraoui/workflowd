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
  for (const { host, port, result } of results)
    assert.ok(
      expected.split("|").includes(result),
      `Unexpected network result for ${host}:${port}: ${result} (expected ${expected})`,
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
    hosts.map((host) => host.address).toSorted((a, b) => a.localeCompare(b)),
    addresses.toSorted((a, b) => a.localeCompare(b)),
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

// http() executes in the engine namespace, bypassing its dagger0 rules.
// Only a server-reported dial timeout counts; a stalled API or GraphQL error
// cannot masquerade as a firewall denial. Unique URLs avoid Dagger's cache.
export function httpScript(targets) {
  return `import base64,concurrent.futures,json,os,urllib.request,uuid
targets=json.loads(${JSON.stringify(JSON.stringify(targets))})
def probe(target):
 host=target['host']
 if ':' in host: host='['+host+']'
 url='http://'+host+':'+str(target['port'])+'/?workflowd-probe='+str(uuid.uuid4())
 query='{http(url:'+json.dumps(url)+'){contents}}'
 request=urllib.request.Request('http://127.0.0.1:'+os.environ['DAGGER_SESSION_PORT']+'/query',data=json.dumps(dict(query=query)).encode(),headers={'Content-Type':'application/json','Authorization':'Basic '+base64.b64encode((os.environ['DAGGER_SESSION_TOKEN']+':').encode()).decode()})
 with urllib.request.urlopen(request,timeout=90) as response: data=json.load(response)
 errors=data.get('errors',[])
 dial='dial tcp '+host+':'+str(target['port'])+':'
 messages=[error.get('message','') for error in errors]
 if messages and all(dial in message and ('i/o timeout' in message or 'connect: connection timed out' in message) for message in messages):
  result='timeout'
 elif isinstance((data.get('data') or {}).get('http'),dict) and isinstance(data['data']['http'].get('contents'),str):
  result='connected'
 else: result='unexpected_response'
 return dict(target,result=result)
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
 print('WORKFLOWD_NETWORK='+json.dumps(list(pool.map(probe,targets))))`
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

// Loopback addresses inside Dagger name the agent itself, not the runner.
export function runnerTargets({ addresses, gateway, defaultGateway }) {
  assert.ok(addresses.length > 0 && addresses.every((ip) => isIP(ip) === 4))
  assert.equal(isIP(gateway), 4, "Docker gateway inventory missing")
  assert.equal(isIP(defaultGateway), 4, "Runner default gateway inventory missing")
  return [
    ...new Set([
      ...addresses,
      gateway,
      defaultGateway,
      "172.17.0.1",
      "169.254.169.254",
      "168.63.129.16",
    ]),
  ]
    .filter((ip) => !ip.startsWith("127."))
    .flatMap((host) => [22, 80].map((port) => ({ host, port })))
}

export function assertRunnerRoutes(routes) {
  for (const line of routes.trim().split("\n").filter(Boolean)) {
    const [prefix] = line.split(/\s+/)
    const [ip, bits = "32"] = prefix.split("/")
    const octets = ip.split(".").map(Number)
    assert.ok(
      isIP(ip) === 4 &&
        octets[0] === 100 &&
        octets[1] >= 64 &&
        octets[1] <= 127 &&
        Number(bits) >= 10 &&
        Number(bits) <= 32,
      `Accepted subnet route in table 52: ${prefix}`,
    )
  }
}

export function dropCounters(save) {
  const counters = {}
  for (const line of save.split("\n")) {
    const match = line.match(/^\[(\d+):\d+\] -A (WFD-[A-Z-]+) .*?-j DROP(?: |$)/)
    if (match) {
      counters[match[2]] = (counters[match[2]] ?? 0) + Number(match[1])
      if (line.includes("-o tailscale0 ")) {
        const key = `${match[2]}:tailscale0`
        counters[key] = (counters[key] ?? 0) + Number(match[1])
      }
    }
  }
  return counters
}

export function assertDropsIncreased(before, after, chains) {
  for (const chain of chains)
    assert.ok(
      Number.isSafeInteger(before[chain]) && after[chain] > before[chain],
      `${chain} drop counter did not increase`,
    )
}

export async function runnerNetworkSnapshot(ssh) {
  const script = `import json,subprocess
def run(args): return subprocess.check_output(args,text=True).strip()
addresses=[a['local'] for i in json.loads(run(['ip','-j','-4','addr','show'])) for a in i['addr_info'] if a['family']=='inet']
network=json.loads(run(['docker','network','inspect','workflowd-sandbox']))[0]
default_gateway=json.loads(run(['ip','-j','-4','route','show','default']))[0]['gateway']
peers=json.loads(run(['tailscale','status','--json']))['Peer']
tailnet6=next(ip for peer in peers.values() for ip in peer['TailscaleIPs'] if ':' in ip)
print(json.dumps(dict(addresses=addresses,defaultGateway=default_gateway,tailnet6=tailnet6,gateway=network['IPAM']['Config'][0]['Gateway'],routes=run(['ip','route','show','table','52']),hostRules=run(['iptables-save','-c']),hostRules6=run(['ip6tables-save','-c']),engineRules=run(['docker','exec','workflowd-sandbox-engine','iptables-save','-c']),engineIPv6=run(['docker','exec','workflowd-sandbox-engine','cat','/proc/sys/net/ipv6/conf/all/disable_ipv6','/proc/sys/net/ipv6/conf/default/disable_ipv6','/proc/sys/net/ipv6/conf/dagger0/disable_ipv6']))))`
  const snapshot = JSON.parse(
    await executeProbe([...ssh.slice(0, -1), "exec sudo -n python3 -"], script),
  )
  assert.equal(snapshot.engineIPv6, "1\n1\n1", "Engine IPv6 must remain disabled")
  assertRunnerRoutes(snapshot.routes)
  return snapshot
}

export async function probeRunnerBoundary(ssh, peerTargets, timeout) {
  const before = await runnerNetworkSnapshot(ssh)
  const localTargets = runnerTargets(before)
  const targets = [...peerTargets, ...localTargets, { host: "10.87.0.1", port: 1234 }]
  const script = "import socket; socket.getaddrinfo('github.com',443)\n" + connectionScript(targets)
  const dagger = await probeDagger(
    ssh,
    script.replace("print(json.dumps", "print('WORKFLOWD_NETWORK='+json.dumps"),
    timeout,
  )
  assertProbeResults(targets, dagger, "timeout")
  const httpTargets = [...peerTargets, ...localTargets]
  const httpTimeout = Math.ceil(httpTargets.length / 16) * 90000 + 30000
  assert.ok(httpTimeout <= 600000, "HTTP inventory exceeds the bounded probe duration")
  const http = await probeDagger(ssh, httpScript(httpTargets), httpTimeout)
  assertProbeResults(httpTargets, http, "timeout")
  // Exercise the host INPUT boundary independently of the engine's earlier drops.
  const tooling = JSON.parse(
    await executeProbe(
      [...ssh.slice(0, -1), "exec docker exec -i workflowd-sandbox-tooling python3 -"],
      "import socket; socket.getaddrinfo('github.com',443)\n" + connectionScript(httpTargets),
      timeout,
    ),
  )
  assertProbeResults(httpTargets, tooling, "timeout")
  assert.equal(isIP(before.tailnet6), 6, "IPv6 tailnet peer inventory missing")
  const ipv6Script = await Bun.file(
    new URL("../../deploy/sandbox/probe-ipv6.sh", import.meta.url),
  ).text()
  await executeProbe(
    [...ssh.slice(0, -1), `exec sudo -n sh -s -- wfd-sandbox0 ${before.tailnet6}`],
    ipv6Script,
    timeout,
  )
  const after = await runnerNetworkSnapshot(ssh)
  assert.deepEqual(runnerTargets(after), localTargets, "Runner address inventory changed")
  assertDropsIncreased(dropCounters(before.engineRules), dropCounters(after.engineRules), [
    "WFD-SANDBOX",
    "WFD-ENGINE",
  ])
  assertDropsIncreased(dropCounters(before.hostRules), dropCounters(after.hostRules), [
    "WFD-HOST",
    "WFD-SANDBOX:tailscale0",
  ])
  assertDropsIncreased(dropCounters(before.hostRules6), dropCounters(after.hostRules6), [
    "WFD-HOST",
    "WFD-SANDBOX:tailscale0",
  ])
  return {
    before,
    after,
    dagger,
    http,
    tooling,
    dns: "resolved github.com from Dagger and tooling",
  }
}
