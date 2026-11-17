import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { Agent, createServer } from "node:https"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  dnsAnswerAddress,
  gatewayTransport,
  localApiSocket,
  localDnsQuery,
  pinnedFetch,
  serviceAddress,
} from "../../deploy/sandbox/gateway-address.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { loopbackCertificate, portOf } from "../helpers/loopback-tls"

/**
 * The runner's lookup of the gateway's Service name (gateway-address.mjs): the answer of
 * tailscaled's resolver through its LocalAPI, and HTTPS to that address with the name kept.
 */

const service = "gateway.fixture.ts.net"

/** The labels of `name` as a DNS name. */
const dnsName = (name: string) =>
  Buffer.concat([
    ...name.split(".").map((label) => Buffer.concat([Buffer.of(label.length), Buffer.from(label)])),
    Buffer.of(0),
  ])

/**
 * A DNS answer of answer code `code` to the question of `name`, A: each record of `records`, its
 * owner a pointer to the question's name.
 */
function dnsAnswer(
  name: string,
  records: ReadonlyArray<{ readonly type: number; readonly data: Buffer }>,
  code = 0,
) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 0)
  header.writeUInt16BE(0x8180 | code, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(records.length, 6)
  const question = Buffer.concat([dnsName(name), Buffer.from([0, 1, 0, 1])])
  const answers = records.map(({ type, data }) => {
    const fixed = Buffer.alloc(12)
    fixed.writeUInt16BE(0xc00c, 0)
    fixed.writeUInt16BE(type, 2)
    fixed.writeUInt16BE(1, 4)
    fixed.writeUInt32BE(600, 6)
    fixed.writeUInt16BE(data.length, 10)
    return Buffer.concat([fixed, data])
  })
  return Buffer.concat([header, question, ...answers])
}
const a = (address: string) => ({ type: 1, data: Buffer.from(address.split(".").map(Number)) })

test("the address of a tailscaled answer is its first tailnet A record; no answer, another code or a public address gives none", () => {
  expect(dnsAnswerAddress(dnsAnswer(service, [a("100.101.102.103")]))).toBe("100.101.102.103")
  // A CNAME before the A record is passed over.
  expect(
    dnsAnswerAddress(
      dnsAnswer(service, [{ type: 5, data: dnsName("other.ts.net") }, a("100.64.0.9")]),
    ),
  ).toBe("100.64.0.9")
  expect(dnsAnswerAddress(dnsAnswer(service, []))).toBeUndefined()
  expect(dnsAnswerAddress(dnsAnswer(service, [a("100.101.102.103")], 3))).toBeUndefined()
  expect(dnsAnswerAddress(dnsAnswer(service, [a("8.8.8.8")]))).toBeUndefined()
  expect(
    dnsAnswerAddress(dnsAnswer(service, [a("100.101.102.103")]).subarray(0, 40)),
  ).toBeUndefined()
  expect(dnsAnswerAddress(Buffer.alloc(4))).toBeUndefined()
})

test("the query asks tailscaled's LocalAPI, as root through sudo, for the A record of the name, and gives the DNS message of its answer", async () => {
  const answer = dnsAnswer(service, [a("100.101.102.103")])
  const calls: Array<ReadonlyArray<string>> = []
  const run = (
    file: string,
    args: ReadonlyArray<string>,
    _options: object,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls.push([file, ...args])
    callback(null, JSON.stringify({ Bytes: answer.toString("base64"), Resolvers: null }))
  }
  await expect(await localDnsQuery(service, run)).toEqual(answer)
  expect(calls).toEqual([
    [
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/curl",
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "10",
      "--unix-socket",
      localApiSocket,
      `http://local-tailscaled.sock/localapi/v0/dns-query?name=${service}&type=A`,
    ],
  ])
  expect(localApiSocket).toBe("/var/run/tailscale/tailscaled.sock")
  for (const fault of [
    (callback: (error: Error | null, stdout: string) => void) => callback(new Error("exit 7"), ""),
    (callback: (error: Error | null, stdout: string) => void) => callback(null, "not json"),
    (callback: (error: Error | null, stdout: string) => void) => callback(null, "{}"),
  ])
    await expect(
      localDnsQuery(service, (_file, _args, _options, callback) => fault(callback)),
    ).rejects.toMatchObject({ code: "ENOTFOUND" })
})

test("a Service name is asked again until tailscaled answers it, at most the number of tries; a name outside the tailnet is never asked", async () => {
  const answer = dnsAnswer(service, [a("100.101.102.103")])
  const asked: Array<string> = []
  const pauses: Array<number> = []
  let left = 2
  const options = {
    query: (name: string) => {
      asked.push(name)
      return left-- > 0 ? Promise.reject(new Error("no netmap yet")) : Promise.resolve(answer)
    },
    pauseMs: 7,
    sleep: (milliseconds: number) => {
      pauses.push(milliseconds)
      return Promise.resolve()
    },
  }
  expect(await serviceAddress(service, options)).toBe("100.101.102.103")
  expect(asked).toEqual([service, service, service])
  expect(pauses).toEqual([7, 7])
  left = 10
  await expect(serviceAddress(service, { ...options, tries: 3 })).rejects.toMatchObject({
    code: "ENOTFOUND",
  })
  asked.length = 0
  for (const name of ["gateway.fixture.invalid", "ts.net", "127.0.0.1", "a.ts.net.evil"])
    await expect(serviceAddress(name, options)).rejects.toMatchObject({ code: "ENOTFOUND" })
  expect(asked).toEqual([])
})

test("in Bun, the pinned fetch connects to the Service's address with its name kept for Host, sends a body, and reads the answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-address-"))
  const tls = await loopbackCertificate(root, service)
  // The certificate names the Service alone, no address: TLS passes only when the client checks
  // it against the name.
  const seen: Array<{ host?: string; body: string }> = []
  const server = createServer(
    { key: await readFile(tls.key), cert: await readFile(tls.cert) },
    (request, response) => {
      let body = ""
      request.on("data", (bytes: Buffer) => (body += bytes.toString()))
      request.on("end", () => {
        seen.push({
          ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
          body,
        })
        response.writeHead(request.url === "/empty" ? 204 : 403, { "x-fixture": "yes" })
        response.end(request.url === "/empty" ? undefined : "refused")
      })
    },
  )
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const port = portOf(server)
  const agent = new Agent({ ca: await readFile(tls.cert) })
  try {
    const send = pinnedFetch(service, "127.0.0.1", agent)
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one "))
        controller.enqueue(new TextEncoder().encode("two"))
        controller.close()
      },
    })
    const response = await send(`https://${service}:${port}/result`, {
      method: "POST",
      body,
      duplex: "half",
      headers: { "content-type": "application/octet-stream" },
    })
    expect(response.status).toBe(403)
    expect(response.headers.get("x-fixture")).toBe("yes")
    expect(await response.text()).toBe("refused")
    expect(seen[0]).toEqual({ host: `${service}:${port}`, body: "one two" })
    const posted = await send(`https://${service}:${port}/text`, { method: "POST", body: "three" })
    await posted.text()
    expect(seen[1]).toEqual({ host: `${service}:${port}`, body: "three" })
    const empty = await send(new URL(`https://${service}:${port}/empty`))
    expect({ status: empty.status, body: empty.body }).toEqual({ status: 204, body: null })
    // Another name is not the Service's: its connection has no address.
    await expect(send(`https://other.fixture.ts.net:${port}/`)).rejects.toMatchObject({
      code: "ENOTFOUND",
    })
    // A signal's reason ends the request, as fetch's does. The end of a request under way is
    // checked in Node (fixtures/pinned-gateway.mjs): Bun 1.3.14's client reports a request that
    // it destroyed as ECONNREFUSED.
    const aborted = new AbortController()
    aborted.abort(new Error("stopped before"))
    await expect(send(`https://${service}:${port}/`, { signal: aborted.signal })).rejects.toThrow(
      "stopped before",
    )
  } finally {
    agent.destroy()
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

// The runner's job runs these modules with Node: its bootstrap, its pinned fetch and its relay are
// tested there.
test("in Node, the bootstrap, the pinned fetch and the relay reach the Service's address with its name kept for TLS and Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-address-"))
  try {
    const tls = await loopbackCertificate(root, service)
    const child = Bun.spawn(
      [
        fixtureExecutable("node"),
        "--test",
        "--test-reporter=tap",
        resolve("test/sandbox/fixtures/pinned-gateway.mjs"),
      ],
      {
        env: { PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: tls.cert, PINNED_KEY: tls.key },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
    expect(stdout).toContain("# pass 3")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("a gateway at a Service name is reached at tailscaled's address; any other gateway host keeps the runtime's fetch and resolver", async () => {
  const answer = dnsAnswer(service, [a("100.101.102.103")])
  const reach = await gatewayTransport(`https://${service}`, {
    query: () => Promise.resolve(answer),
  })
  await expect(reach.address).toBe("100.101.102.103")
  expect(reach.send).not.toBe(fetch)
  const lookup = reach.lookup!
  const answered = await new Promise((done) =>
    lookup(service, {}, (error, address, family) => done({ error, address, family })),
  )
  expect(answered).toEqual({ error: null, address: "100.101.102.103", family: 4 })
  const all = await new Promise((done) =>
    lookup(service, { all: true }, (error, addresses) => done({ error, addresses })),
  )
  expect(all).toEqual({ error: null, addresses: [{ address: "100.101.102.103", family: 4 }] })
  for (const gateway of ["https://127.0.0.1:8443", "https://gateway.fixture.invalid"])
    expect(await gatewayTransport(gateway)).toEqual({
      send: fetch,
      lookup: undefined,
      address: undefined,
    })
  await expect(
    gatewayTransport(`https://${service}`, {
      query: () => Promise.reject(new Error("no answer")),
      tries: 1,
    }),
  ).rejects.toMatchObject({ code: "ENOTFOUND" })
})
