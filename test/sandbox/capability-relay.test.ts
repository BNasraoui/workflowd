import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { client, processGateway, proof, withGateway } from "../capability-gateway/gateway-process"
import { renewalRequests } from "../../deploy/sandbox/renewal.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { loopbackCertificate, tlsFront } from "../helpers/loopback-tls"

for (const scenario of ["headers", "renewal", "git-refs", "git-upload"] as const) {
  test(`the relay survives ${scenario} failure and serves the next valid request`, async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-regression-"))
    const now = Date.now()
    const first = "a".repeat(43)
    const next = "b".repeat(43)
    const gitPath =
      scenario === "git-refs"
        ? "/capabilities/v1/git/12.git/info/refs?service=git-upload-pack"
        : scenario === "git-upload"
          ? "/capabilities/v1/git/12.git/git-upload-pack"
          : undefined
    const expiry = now + 15000
    const tls = await loopbackCertificate(root)
    let attempts = 0
    let requests = 0
    const renewed = Promise.withResolvers<void>()
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(tls.key), cert: Bun.file(tls.cert) },
      async fetch(request) {
        const url = new URL(request.url)
        const target = url.pathname + url.search
        await request.arrayBuffer()
        if (target === "/capabilities/v1/renew") {
          attempts++
          expect(request.headers.get("authorization")).toBe(`Bearer ${first}`)
          if (attempts === 1) return new Response(null, { status: 503 })
          renewed.resolve()
          return Response.json({ token: next, expiresAt: expiry, renewAt: expiry - 1000 })
        }
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${scenario === "renewal" ? next : first}`,
        )
        expect(request.method).toBe(scenario === "git-refs" ? "GET" : "POST")
        expect(target).toBe(gitPath ?? "/capabilities/v1/providers/fixture-provider/v1/messages")
        requests++
        return new Response("fixture-stream")
      },
    })
    const child = Bun.spawn(
      [
        fixtureExecutable("node"),
        resolve("test/sandbox/fixtures/capability-job.mjs"),
        "runner",
        root,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: tls.cert },
        stdin: new Blob([
          JSON.stringify({
            token: first,
            expiresAt: expiry,
            renewAt: scenario === "renewal" ? now + 100 : expiry - 1000,
            deadline: expiry,
            providerId: "fixture-provider",
            gateway: `https://127.0.0.1:${gateway.port}`,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      expect(Buffer.from((await child.stdout.getReader().read()).value ?? []).toString()).toBe(
        "ready\n",
      )
      const request = (headers: Record<string, string> = {}) =>
        fetch("http://capability.invalid" + (gitPath ?? "/v1/messages"), {
          unix: join(root, "gateway.sock"),
          method: scenario === "git-refs" ? "GET" : "POST",
          headers: { authorization: "Bearer workflowd-local", ...headers },
          body: scenario === "git-refs" ? undefined : "{}",
        })
      if (scenario === "headers") {
        const response = await request({ "keep-alive": "timeout=5" }).catch(() => null)
        expect(response?.status).toBe(403)
      } else if (scenario === "renewal")
        await Promise.race([
          renewed.promise,
          child.exited.then(() => {
            throw new Error("relay died during transient renewal")
          }),
        ])
      expect(child.exitCode).toBeNull()
      const response = await request()
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("fixture-stream")
      expect(requests).toBe(1)
      expect(attempts).toBe(scenario === "renewal" ? 2 : 0)
    } finally {
      await gateway.stop(true)
      child.kill("SIGKILL")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}

test("after a clock jump past its expiry, the relay sends no renewal of the expired token and ends for expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-clock-tls-"))
  try {
    const tls = await loopbackCertificate(root)
    const child = Bun.spawn(
      [fixtureExecutable("node"), "--test", resolve("test/sandbox/fixtures/relay-clock.mjs")],
      {
        env: { PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: tls.cert, RELAY_CLOCK_KEY: tls.key },
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test("after stop, the answer of a renewal in flight sends no further request", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-stop-tls-"))
  try {
    const tls = await loopbackCertificate(root)
    const child = Bun.spawn(
      [fixtureExecutable("node"), "--test", resolve("test/sandbox/fixtures/relay-stop.mjs")],
      {
        env: { PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: tls.cert, RELAY_CLOCK_KEY: tls.key },
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test("the relay refuses a config whose provider id is missing or not of the form", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-provider-"))
  try {
    for (const providerId of [undefined, "", "Anthropic", "../x", "a/b", 1]) {
      const child = Bun.spawn(
        [fixtureExecutable("node"), resolve("deploy/sandbox/capability-relay.mjs"), "runner", root],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdin: new Blob([
            JSON.stringify({
              token: "a".repeat(43),
              expiresAt: Date.now() + 1000,
              renewAt: Date.now() + 500,
              deadline: Date.now() + 2000,
              providerId,
              gateway: "https://127.0.0.1:1",
            }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ providerId, code, stdout, stderr }).toEqual({
        providerId,
        code: 1,
        stdout: "",
        stderr: "capability relay unavailable\n",
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the relay refuses a gateway that is not an HTTPS origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-origin-"))
  try {
    for (const gateway of [
      "http://127.0.0.1:1",
      "https://user@127.0.0.1:1",
      "https://127.0.0.1:1/path",
      "https://127.0.0.1:1/?q=1",
    ]) {
      const child = Bun.spawn(
        [fixtureExecutable("node"), resolve("deploy/sandbox/capability-relay.mjs"), "runner", root],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdin: new Blob([
            JSON.stringify({
              token: "a".repeat(43),
              expiresAt: Date.now() + 1000,
              renewAt: Date.now() + 500,
              deadline: Date.now() + 2000,
              providerId: "anthropic",
              gateway,
            }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({
        code: 1,
        stdout: "",
        stderr: "capability relay unavailable\n",
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the relay asks one renewal no more often than the gateway permits, and its last failure ends the session with a logged reason", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const root = await mkdtemp(join(tmpdir(), "relay-renewals-"))
    const tls = await loopbackCertificate(root)
    // Each renewal that the gateway grants is lost on the way back: the gateway has replaced the
    // successor, the relay never gets it.
    const renewals: Array<number | undefined> = []
    const front = await tlsFront(tls, gateway.port, (path, status) => {
      if (path !== "/capabilities/v1/renew") return false
      renewals.push(status)
      return status === 200
    })
    const runner = client(gateway.port)
    try {
      // A token that lives 180 seconds is due for renewal at once: renewAt is 180 to 300 seconds
      // before its expiry, and never later.
      await f.tokenSeconds(180)
      const { audience } = await runner.audience()
      const answer = await runner.session(proof(audience, "jti-relay"))
      expect(answer.status).toBe(200)
      const grant = await runner.grant(answer)
      // Each successor outlives its predecessor, so the gateway grants each permitted renewal.
      await f.tokenSeconds(300)
      const child = Bun.spawn(
        [
          fixtureExecutable("node"),
          resolve("test/sandbox/fixtures/capability-job.mjs"),
          "runner",
          root,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: tls.cert },
          stdin: new Blob([
            JSON.stringify({ ...grant, gateway: `https://127.0.0.1:${front.port}` }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      // The relay ends by itself once its last permitted renewal is lost.
      const ended = await Promise.race([child.exited, Bun.sleep(25000).then(() => "live")])
      child.kill("SIGKILL")
      expect(ended).toBe(0)
      // The gateway permits one successor and three replacements of it: four renewals, all granted.
      expect(renewalRequests).toBe(4)
      expect(renewals).toEqual(Array.from({ length: renewalRequests }, () => 200))
      expect(await readFile(join(root, "relay-ended"), "utf8")).toBe("renewal\n")
    } finally {
      front.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}, 40000)

test("a renewal that the gateway refuses ends the relay at once: it sends no further request and its open stream ends", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const root = await mkdtemp(join(tmpdir(), "relay-refused-"))
    const tls = await loopbackCertificate(root)
    const answers: Array<[string | undefined, number | undefined]> = []
    const streamOpen = Promise.withResolvers<void>()
    const front = await tlsFront(
      tls,
      gateway.port,
      (path, status) => {
        answers.push([path, status])
        return false
      },
      // The renewal reaches the gateway only once a client's stream is open through the relay.
      (path) => (path === "/capabilities/v1/renew" ? streamOpen.promise : undefined),
    )
    const runner = client(gateway.port)
    try {
      const { audience } = await runner.audience()
      const answer = await runner.session(proof(audience, "jti-relay"))
      expect(answer.status).toBe(200)
      // The token lives 15 minutes, more than the renewal window of 330 s: the gateway refuses to renew it.
      const grant = await runner.grant(answer)
      expect(grant.expiresAt - Date.now()).toBeGreaterThan(330000)
      f.setStall(true)
      const child = Bun.spawn(
        [
          fixtureExecutable("node"),
          resolve("test/sandbox/fixtures/capability-job.mjs"),
          "runner",
          root,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: tls.cert },
          stdin: new Blob([
            JSON.stringify({
              ...grant,
              renewAt: Date.now(),
              gateway: `https://127.0.0.1:${front.port}`,
            }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      try {
        const output = child.stdout.getReader()
        expect(Buffer.from((await output.read()).value ?? []).toString()).toBe("ready\n")
        output.releaseLock()
        const stream = await fetch("http://relay/v1/messages", {
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
        expect(stream.status).toBe(200)
        const reader = stream.body!.getReader()
        const stalledEvent = "event: message_start\ndata: {}\n\n"
        // The gateway holds back the tail of a stream until it has checked it, so the open stream
        // has given a first part of the upstream's first event.
        const first = Buffer.from((await reader.read()).value ?? []).toString()
        expect(first).not.toBe("")
        expect(stalledEvent.startsWith(first)).toBe(true)
        streamOpen.resolve()
        const next = await reader.read().then(
          (item) => (item.done ? "ended" : Buffer.from(item.value).toString()),
          () => "ended",
        )
        expect(next).toBe("ended")
        expect(await child.exited).toBe(0)
      } finally {
        child.kill("SIGKILL")
      }
      expect(answers).toEqual([
        ["/capabilities/v1/providers/anthropic/v1/messages", 200],
        ["/capabilities/v1/renew", 403],
      ])
      expect(await readFile(join(root, "relay-ended"), "utf8")).toBe("renewal\n")
      expect(await f.mints()).toBe(1)
    } finally {
      front.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}, 40000)
