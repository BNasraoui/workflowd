import { expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { runnerAddress } from "../helpers/loopback-tls"
import {
  client,
  fixture,
  gatewaySource,
  processGateway,
  proof,
  sse,
  startGatewayProcess,
  withGateway,
  type Fixture,
} from "./gateway-process"

/** The gateway process of `f` with its listen section replaced by `listen`. */
const startWith = (f: Fixture, listen: object) =>
  startGatewayProcess(
    [process.execPath, "-e", gatewaySource(f)],
    { ...f.env, WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...f.config, listen }) },
    f.front,
  )

/** Whether a path exists, without following a symbolic link. */
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

/**
 * The TCP sockets in the listen state of this network namespace and this uid that no process
 * whose descriptors this uid may read holds. A process that is not dumpable, as the gateway is,
 * shows no descriptor to its own uid: each such socket is held by one.
 */
async function unattributedListeners() {
  const uid = String(process.getuid!())
  const listening = new Map<string, string>()
  for (const table of ["tcp", "tcp6"])
    for (const line of (await readFile(`/proc/self/net/${table}`, "utf8")).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields[3] === "0A" && fields[7] === uid)
        listening.set(fields[9] ?? "", `${table} ${fields[1]}`)
    }
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")
      listening.delete(/^socket:\[(\d+)\]$/.exec(target)?.[1] ?? "")
    }
  }
  return [...listening.values()].sort()
}

/** A run token of the fixture run, from a session through the front. */
async function runToken(f: Fixture) {
  const runner = client(f.front)
  const { audience } = await runner.audience()
  return (await runner.grant(await runner.session(proof(audience, "jti-listener")))).token
}

/** The names of the headers that reached the model upstream, lowercase and sorted. */
const upstreamHeaderNames = (f: Fixture) =>
  [...new Set(f.upstreamRequests().flatMap((request) => Object.keys(request.headers)))].sort()

for (const key of ["host", "port"] as const)
  test(`a listen section with a ${key} ends the gateway process with a fixed error, and no socket is made`, async () => {
    const f = await fixture()
    try {
      const listen = { ...f.config.listen, [key]: key === "host" ? "127.0.0.1" : 8443 }
      await expect(startWith(f, listen)).rejects.toThrow(
        new RegExp(`SchemaError: Expected no excess property\\s+at \\["listen"\\]\\["${key}"\\]`),
      )
      expect(await exists(join(f.root, "front"))).toBe(false)
    } finally {
      await f.close()
    }
  })

test("a listener directory that fails a check ends the gateway process with a fixed error, and no socket is made", async () => {
  const f = await fixture()
  try {
    const socket = (directory: string) => join(directory, "gateway.sock")
    // The directory of another mode.
    const wide = join(f.root, "wide")
    await mkdir(wide, { mode: 0o755 })
    await chmod(wide, 0o755)
    // A directory above it that its group may write to, with no sticky bit.
    const shared = join(f.root, "shared")
    await mkdir(shared)
    await chmod(shared, 0o775)
    // A directory named through a symbolic link.
    await symlink(f.root, join(f.root, "link"))
    for (const [directory, fault] of [
      [wide, "capability listener directory must be the gateway's, mode 0710, the front's group"],
      [
        join(shared, "front"),
        `${shared} lets another user replace the capability listener directory`,
      ],
      [
        join(f.root, "link", "front"),
        "capability listener directory must be named by its real path",
      ],
    ] as const) {
      await expect(startWith(f, { ...f.config.listen, socket: socket(directory) })).rejects.toThrow(
        fault,
      )
      expect(await exists(socket(directory))).toBe(false)
    }
    expect(await exists(join(shared, "front"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("through the front and the relay, a session, a renewal and a model call work; the upstream sees no forwarding or Tailscale header", async () => {
  await withGateway(processGateway, async (f) => {
    const root = await mkdtemp(join(tmpdir(), "wfd-listener-relay-"))
    const answers: Array<[string | undefined, number | undefined]> = []
    f.front.hook({
      lost: (path, status) => {
        answers.push([path, status])
        return false
      },
    })
    const runner = client(f.front)
    // A token that lives 180 seconds may be renewed at once.
    await f.tokenSeconds(180)
    const { audience } = await runner.audience()
    const opened = await runner.session(proof(audience, "jti-relay"))
    expect(opened.status).toBe(200)
    const grant = await runner.grant(opened)
    await f.tokenSeconds(null)
    const relay = Bun.spawn(
      [
        fixtureExecutable("node"),
        resolve("test/sandbox/fixtures/capability-job.mjs"),
        "runner",
        root,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: f.tls.cert },
        stdin: new Blob([
          JSON.stringify({ ...grant, renewAt: Date.now(), gateway: f.front.origin }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const output = relay.stdout.getReader()
      expect(Buffer.from((await output.read()).value ?? []).toString()).toBe("ready\n")
      output.releaseLock()
      for (let tries = 0; tries < 200; tries++) {
        if (answers.some(([path]) => path === "/capabilities/v1/renew")) break
        await Bun.sleep(25)
      }
      const call = await fetch("http://relay/v1/messages", {
        unix: join(root, "gateway.sock"),
        method: "POST",
        headers: {
          authorization: "Bearer workflowd-local",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: JSON.stringify({ model: "fixture-model", stream: true, messages: [] }),
      })
      expect(call.status).toBe(200)
      expect(await call.text()).toBe(sse)
    } finally {
      relay.kill("SIGKILL")
      await relay.exited
      await rm(root, { recursive: true, force: true })
    }
    expect(answers).toEqual([
      ["/capabilities/v1/challenge?lease=lease", 200],
      ["/capabilities/v1/session", 200],
      ["/capabilities/v1/renew", 200],
      ["/capabilities/v1/providers/anthropic/v1/messages", 200],
    ])
    expect(f.upstreamRequests()).toHaveLength(1)
    expect(
      upstreamHeaderNames(f).filter(
        (name) => name.startsWith("x-forwarded-") || name.startsWith("tailscale-"),
      ),
    ).toEqual([])
  })
}, 30000)

test("a request whose headers are not those that Serve sends for a tagged node gets an empty 403, and the upstream sees nothing", async () => {
  await withGateway(processGateway, async (f) => {
    const token = await runToken(f)
    const runner = client(f.front)
    const sent = () => f.upstreamRequests().length
    expect((await runner.call(token)).status).toBe(200)
    // The front's own headers for another form of a tailnet address pass.
    f.front.hook({ alter: (headers) => ({ ...headers, "x-forwarded-for": ["fd7a:115c:a1e0::7"] }) })
    expect((await runner.call(token)).status).toBe(200)
    const before = sent()
    const refused = async (
      reason: string,
      alter: (headers: Record<string, Array<string>>) => Record<string, Array<string>>,
      extra: Record<string, string> = {},
    ) => {
      f.front.hook({ alter })
      const answer = await runner.provider(
        token,
        JSON.stringify({ model: "fixture-model", stream: true, messages: [] }),
        extra,
      )
      expect({ reason, status: answer.status, body: await answer.text() }).toEqual({
        reason,
        status: 403,
        body: "",
      })
    }
    const without = (headers: Record<string, Array<string>>, name: string) =>
      Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name))
    await refused("a second X-Forwarded-For", (headers) => ({
      ...headers,
      "x-forwarded-for": [runnerAddress, runnerAddress],
    }))
    await refused("an X-Forwarded-For list", (headers) => ({
      ...headers,
      "x-forwarded-for": [`${runnerAddress}, 100.64.0.8`],
    }))
    for (const address of ["192.0.2.1", "100.128.0.1", "fd7a:115c:a1e1::1", "::ffff:100.64.0.7"])
      await refused(`X-Forwarded-For ${address}`, (headers) => ({
        ...headers,
        "x-forwarded-for": [address],
      }))
    await refused("no X-Forwarded-For", (headers) => without(headers, "x-forwarded-for"))
    await refused("no X-Forwarded-Proto", (headers) => without(headers, "x-forwarded-proto"))
    await refused("X-Forwarded-Proto http", (headers) => ({
      ...headers,
      "x-forwarded-proto": ["http"],
    }))
    await refused("no X-Forwarded-Host", (headers) => without(headers, "x-forwarded-host"))
    // A runner that names another host: Serve sends that host on.
    await refused("a wrong X-Forwarded-Host", (headers) => headers, { host: "gateway.example" })
    // Serve drops a client's Forwarded and its identity headers, and adds those of a user's node.
    await refused("Forwarded", (headers) => ({ ...headers, forwarded: ["for=100.64.0.7"] }))
    await refused("Tailscale-User-Login", (headers) => ({
      ...headers,
      "tailscale-user-login": ["user@example.com"],
    }))
    // Serve passes each of these on from the client.
    for (const name of [
      "X-Forwarded-Port",
      "X-Forwarded-Server",
      "X-Real-IP",
      "Via",
      "Tailscale-Fixture",
    ])
      await refused(name, (headers) => headers, { [name]: "100.64.0.9" })
    expect(sent()).toBe(before)
    f.front.hook({})
    expect((await runner.call(token)).status).toBe(200)
  })
}, 30000)

test("a connection to the listener from a uid that is not the front's is ended with no route called", async () => {
  const f = await fixture()
  const gateway = await startWith(f, {
    ...f.config.listen,
    front: { uid: process.getuid!() + 1, gid: process.getgid!() },
  })
  try {
    await f.reconcile()
    const answer = await new Promise<string>((done) => {
      const socket = connect(f.config.listen.socket)
      let text = ""
      socket.on("data", (bytes) => (text += bytes.toString()))
      socket.on("error", () => undefined)
      socket.on("close", () => done(text))
      socket.write(
        `GET /capabilities/v1/challenge?lease=lease HTTP/1.1\r\nhost: localhost\r\nx-forwarded-for: ${runnerAddress}\r\nx-forwarded-proto: https\r\nx-forwarded-host: ${f.config.listen.service}\r\n\r\n`,
      )
    })
    expect(answer).toBe("")
    // The front, run as this uid, is ended too: it answers 502, as Serve does.
    expect((await client(f.front).challenge("lease")).status).toBe(502)
    // No route ran: no challenge was issued, so the gateway's store binds no channel.
    expect(
      await f.gatewaySql(
        (sql) => sql<{ readonly count: number }>`SELECT count(*) AS count FROM capability_bindings`,
      ),
    ).toEqual([{ count: 0 }])
  } finally {
    await gateway.stop()
    await f.close()
  }
})

/**
 * The unattributed TCP listeners (`unattributedListeners`) that appear once `start` has run and
 * are gone once its stop has: those of the process it starts, also on a host where other
 * processes of this uid open and close listeners.
 */
async function listenersOf(start: () => Promise<() => Promise<void>>) {
  const before = await unattributedListeners()
  const stop = await start()
  let during: string[]
  try {
    during = await unattributedListeners()
  } finally {
    await stop()
  }
  const after = await unattributedListeners()
  return during.filter((entry) => !before.includes(entry) && !after.includes(entry))
}

test("the gateway process holds no TCP socket in the listen state", async () => {
  const f = await fixture()
  try {
    const held = await listenersOf(async () => {
      const gateway = await processGateway(f)
      expect((await client(gateway).challenge("lease")).status).toBe(200)
      return gateway.stop
    })
    expect(held).toEqual([])
  } finally {
    await f.close()
  }
  // The same read finds the TCP listener of a process that is not dumpable.
  const listener = await listenersOf(async () => {
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { forbidCoreFiles } from ${JSON.stringify(resolve("src/capability-gateway/custody.ts"))}
forbidCoreFiles()
require("node:net").createServer().listen(0, "127.0.0.1", () => console.log("listening"))`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    const output = holder.stdout.getReader()
    expect(Buffer.from((await output.read()).value ?? []).toString()).toBe("listening\n")
    return async () => {
      holder.kill("SIGKILL")
      await holder.exited
    }
  })
  expect(listener).toHaveLength(1)
})
