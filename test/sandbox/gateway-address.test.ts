import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  dnsAnswerAddress,
  gatewayTransport,
  localApiSocket,
  localDnsQuery,
  serviceAddress,
} from "../../deploy/sandbox/gateway-address.mjs"
import { prepare } from "../../deploy/sandbox/bootstrap.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { loopbackCertificate } from "../helpers/loopback-tls"

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

// The runner's job runs these modules with Node: its pinned fetch and its relay are tested there.
test("in Node, the pinned fetch and the relay reach the Service's address with its name kept for TLS and Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-address-"))
  try {
    const tls = await loopbackCertificate(root, service)
    const child = Bun.spawn(
      [fixtureExecutable("node"), "--test", resolve("test/sandbox/fixtures/pinned-gateway.mjs")],
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
    expect(stdout).toContain("# pass 2")
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

test("the runner's bootstrap opens its gateway session through the transport of the gateway's Service name", async () => {
  const asked: Array<string> = []
  const sent: Array<string> = []
  const failure = await prepare({
    harness: ["/bin/false"],
    directory: "/nonexistent",
    environment: {
      GITHUB_SHA: "a".repeat(40),
      GITHUB_REF: "refs/heads/workflowd/leases/lease",
      GITHUB_REPOSITORY: "fixture/repo",
      SANDBOX_AGENT_IMAGE: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
      SANDBOX_GATEWAY_URL: `https://${service}`,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
    },
    identity: () => Promise.reject(new Error("no proof is asked")),
    transport: (gateway: string) => {
      asked.push(gateway)
      return Promise.resolve({
        send: (url: URL) => {
          sent.push(url.host)
          return Promise.resolve(new Response(null, { status: 400 }))
        },
        address: "100.101.102.103",
      })
    },
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(asked).toEqual([`https://${service}`])
  expect(sent).toEqual([service])
})
