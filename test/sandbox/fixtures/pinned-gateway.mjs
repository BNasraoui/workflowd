// Node's side of the runner's lookup of the gateway's Service name (gateway-address.mjs), in the
// runtime of the runner's job: the pinned fetch, and the relay with the address that the
// bootstrap gives it. The gateway is an HTTPS server on 127.0.0.1 whose certificate names the
// Service alone (PINNED_KEY, NODE_EXTRA_CA_CERTS), so each TLS check that passes was of the name.
import { test } from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"
import { pinnedFetch } from "../../../deploy/sandbox/gateway-address.mjs"
import { relayConfig } from "./relay-config.mjs"

const service = "gateway.fixture.ts.net"

/** The gateway: each request's Host and body, an answer by its path. */
async function gateway() {
  const seen = []
  const server = createServer({
    key: await readFile(process.env.PINNED_KEY),
    cert: await readFile(process.env.NODE_EXTRA_CA_CERTS),
  })
  server.on("request", (request, response) => {
    let body = ""
    request.on("data", (bytes) => (body += bytes.toString()))
    request.on("end", () => {
      seen.push({ path: request.url, host: request.headers.host, body })
      if (request.url === "/slow") return
      response.writeHead(request.url === "/empty" ? 204 : 403, { "x-fixture": "yes" })
      response.end(request.url === "/empty" ? undefined : "refused")
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, seen, port: server.address().port }
}

test("the pinned fetch reaches the Service's address with its name kept for TLS and Host", async () => {
  const { server, seen, port } = await gateway()
  try {
    const send = pinnedFetch(service, "127.0.0.1")
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
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("x-fixture"), "yes")
    assert.equal(await response.text(), "refused")
    assert.deepEqual(seen[0], { path: "/result", host: `${service}:${port}`, body: "one two" })
    const empty = await send(new URL(`https://${service}:${port}/empty`))
    assert.deepEqual({ status: empty.status, body: empty.body }, { status: 204, body: null })
    // Another name is not the Service's: its connection has no address.
    await assert.rejects(send(`https://other.fixture.ts.net:${port}/`), { code: "ENOTFOUND" })
    // The same address under another name fails the certificate's check of that name.
    await assert.rejects(
      pinnedFetch("other.fixture.ts.net", "127.0.0.1")(`https://other.fixture.ts.net:${port}/`),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    )
    // A signal's reason ends the request, as fetch's does.
    await assert.rejects(
      send(`https://${service}:${port}/slow`, { signal: AbortSignal.timeout(100) }),
      { name: "TimeoutError" },
    )
    const aborted = new AbortController()
    aborted.abort(new Error("stopped before"))
    await assert.rejects(send(`https://${service}:${port}/`, { signal: aborted.signal }), {
      message: "stopped before",
    })
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("the relay sends each call to the address that the bootstrap gave for the Service's name, with the name kept", async () => {
  const { server, seen, port } = await gateway()
  const root = await mkdtemp(join(tmpdir(), "pinned-relay-"))
  const config = {
    ...relayConfig(Date.now(), port),
    gateway: `https://${service}:${port}`,
    gatewayAddress: "127.0.0.1",
  }
  const relay = await serveRunnerRelay(config, root)
  try {
    const answer = await relay.runRoute("launch")
    assert.equal(answer.status, 403)
    assert.deepEqual(seen.at(-1), {
      path: "/capabilities/v1/run/launch",
      host: `${service}:${port}`,
      body: "",
    })
  } finally {
    relay.close()
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
  // An address that is not an IPv4 address is refused.
  for (const gatewayAddress of ["localhost", "::1", 7])
    await assert.rejects(serveRunnerRelay({ ...config, gatewayAddress }, root), {
      message: "relay configuration refused",
    })
})
