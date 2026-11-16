import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  client,
  processGateway,
  proof,
  runnerKey,
  sse,
  withGateway,
  type Fixture,
  type Gateway,
} from "../capability-gateway/gateway-process"
import { sessionKeyPair } from "../../deploy/sandbox/renewal.mjs"
import { renewalRequests } from "../../deploy/sandbox/renewal.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { loopbackCertificate } from "../helpers/loopback-tls"

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
            channel: "c".repeat(64),
            sessionKey: sessionKeyPair().privateKey,
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

test("stop cuts a renewal in flight, and its answer after stop sends no further request even when the agent keeps the connection", async () => {
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
              channel: "c".repeat(64),
              sessionKey: sessionKeyPair().privateKey,
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
              channel: "c".repeat(64),
              sessionKey: sessionKeyPair().privateKey,
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
    // Each renewal that the gateway grants is lost on the way back: the gateway has replaced the
    // successor, the relay never gets it.
    const renewals: Array<number | undefined> = []
    const attempts: Array<unknown> = []
    f.front.hook({
      lost: (path, status) => {
        if (path !== "/capabilities/v1/renew") return false
        renewals.push(status)
        return status === 200
      },
      copied: (path, _, body) => {
        if (path === "/capabilities/v1/renew") attempts.push(JSON.parse(body).attempt)
      },
    })
    const runner = client(gateway)
    try {
      // A token that lives 180 seconds is due for renewal at once: renewAt is 180 to 300 seconds
      // before its expiry, and never later.
      await f.tokenSeconds(180)
      const { audience, channel } = await runner.audience()
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
          env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: f.tls.cert },
          stdin: new Blob([
            JSON.stringify({
              ...grant,
              channel,
              sessionKey: runnerKey.privateKey,
              gateway: f.front.origin,
            }),
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
      // Each request, each retry too, has the next attempt number of the session.
      expect(attempts).toEqual(["1", "2", "3", "4"])
      expect(await readFile(join(root, "relay-ended"), "utf8")).toBe("renewal\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}, 40000)

test("a renewal that the gateway refuses ends the relay at once: it sends no further request and its open stream ends", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const root = await mkdtemp(join(tmpdir(), "relay-refused-"))
    const answers: Array<[string | undefined, number | undefined]> = []
    const streamOpen = Promise.withResolvers<void>()
    const runner = client(gateway)
    try {
      const { audience, channel } = await runner.audience()
      const answer = await runner.session(proof(audience, "jti-relay"))
      expect(answer.status).toBe(200)
      // From here, the front records each answer to the relay.
      f.front.hook({
        lost: (path, status) => {
          answers.push([path, status])
          return false
        },
        // The renewal reaches the gateway only once a client's stream is open through the relay.
        held: (path) => (path === "/capabilities/v1/renew" ? streamOpen.promise : undefined),
      })
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
          env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: f.tls.cert },
          stdin: new Blob([
            JSON.stringify({
              ...grant,
              channel,
              sessionKey: runnerKey.privateKey,
              renewAt: Date.now(),
              gateway: f.front.origin,
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
          body: JSON.stringify({
            model: "fixture-model",
            stream: true,
            messages: [],
            max_tokens: 1000,
          }),
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
      await rm(root, { recursive: true, force: true })
    }
  })
}, 40000)

test("the relay refuses a config whose channel or session key is missing or not of the form", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-session-key-"))
  try {
    const { generateKeyPairSync } = await import("node:crypto")
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64url")
    const valid = sessionKeyPair().privateKey
    for (const [channel, sessionKey] of [
      [undefined, valid],
      ["C".repeat(64), valid],
      ["c".repeat(63), valid],
      ["c".repeat(64), undefined],
      ["c".repeat(64), ""],
      ["c".repeat(64), sessionKeyPair().publicKey],
      ["c".repeat(64), rsa],
      ["c".repeat(64), 7],
    ]) {
      const child = Bun.spawn(
        [fixtureExecutable("node"), resolve("deploy/sandbox/capability-relay.mjs"), "runner", root],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdin: new Blob([
            JSON.stringify({
              token: "a".repeat(43),
              channel,
              sessionKey,
              expiresAt: Date.now() + 1000,
              renewAt: Date.now() + 500,
              deadline: Date.now() + 2000,
              providerId: "anthropic",
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
      expect({ channel, code, stdout, stderr }).toEqual({
        channel,
        code: 1,
        stdout: "",
        stderr: "capability relay unavailable\n",
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Opens the run's session through the front with a token that may be renewed at once, and starts
 * the real relay in `root` with its grant, channel and session key; the relay renews `renewIn`
 * milliseconds after its start. Each successor outlives its predecessor, so the gateway grants a
 * renewal. Runs `body` once the relay is ready; then ends the relay and waits for its exit.
 */
async function withRelayOfRun(
  f: Fixture,
  gateway: Gateway,
  root: string,
  renewIn: number,
  body: (relay: {
    readonly runner: ReturnType<typeof client>
    readonly grant: { readonly token: string }
    readonly channel: string
    readonly child: Bun.Subprocess
    readonly call: () => Promise<Response>
  }) => Promise<void>,
) {
  const runner = client(gateway)
  await f.tokenSeconds(200)
  const { audience, channel } = await runner.audience()
  const grant = await runner.grant(await runner.session(proof(audience, "jti-relay")))
  await f.tokenSeconds(300)
  const child = Bun.spawn(
    [
      fixtureExecutable("node"),
      resolve("test/sandbox/fixtures/capability-job.mjs"),
      "runner",
      root,
    ],
    {
      env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: f.tls.cert },
      stdin: new Blob([
        JSON.stringify({
          ...grant,
          channel,
          sessionKey: runnerKey.privateKey,
          renewAt: Date.now() + renewIn,
          gateway: f.front.origin,
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
    const call = () =>
      fetch("http://relay/v1/messages", {
        unix: join(root, "gateway.sock"),
        method: "POST",
        headers: {
          authorization: "Bearer workflowd-local",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: true,
          messages: [],
          max_tokens: 100,
        }),
      })
    await body({ runner, grant, channel, child, call })
  } finally {
    child.kill("SIGKILL")
    await child.exited
  }
}

/** Runs `body` with a new directory named by `prefix`, and removes the directory after it. */
async function inDirectory(prefix: string, body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The statuses of the gateway's answers to the relay's renewals, in the order the front got them. */
function renewalAnswers() {
  const statuses: Array<number | undefined> = []
  const waiting: Array<{ readonly count: number; readonly reached: () => void }> = []
  return {
    statuses,
    record: (status: number | undefined) => {
      statuses.push(status)
      for (const { count, reached } of waiting) if (statuses.length >= count) reached()
    },
    /** Settles once the front has got `count` answers. */
    reach: (count: number) => {
      const reached = Promise.withResolvers<void>()
      waiting.push({ count, reached: reached.resolve })
      if (statuses.length >= count) reached.resolve()
      return reached.promise
    },
  }
}

/** The relay still runs, and the gateway has not ended the run. */
async function runGoesOn(f: Fixture, child: Bun.Subprocess) {
  expect(child.exitCode).toBeNull()
  expect(
    await f.gatewaySql(
      (sql) =>
        sql`SELECT revoked,end_reason AS endReason FROM capability_grants WHERE run_id='run'`,
    ),
  ).toEqual([{ revoked: 0, endReason: null }])
}

test("a party with a copy of the run token cannot renew it, and the relay's signed renewal goes on", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const renewals = renewalAnswers()
    f.front.hook({
      lost: (path, status) => {
        if (path === "/capabilities/v1/renew") renewals.record(status)
        return false
      },
    })
    await inDirectory("relay-copy-", (root) =>
      withRelayOfRun(f, gateway, root, 3000, async ({ runner, grant, channel, child, call }) => {
        // The copy's holder has no session key of the run: no body of its own is taken.
        expect((await runner.renewWith(grant.token, "{}")).status).toBe(403)
        expect((await client(gateway, sessionKeyPair()).renew(grant.token, channel)).status).toBe(
          403,
        )
        await renewals.reach(3)
        expect(renewals.statuses).toEqual([403, 403, 200])
        const answer = await call()
        expect(answer.status).toBe(200)
        expect(await answer.text()).toBe(sse)
        // The relay's call used the successor, so the copied predecessor is refused from now on.
        expect((await runner.call(grant.token)).status).toBe(403)
        await runGoesOn(f, child)
      }),
    )
  })
}, 40000)

test("a copy of the relay's own renewal request, sent again before and after the successor's first call, has no effect, and the relay goes on", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const renewals = renewalAnswers()
    const copied = Promise.withResolvers<{ readonly token: string; readonly body: string }>()
    f.front.hook({
      lost: (path, status) => {
        if (path === "/capabilities/v1/renew") renewals.record(status)
        return false
      },
      copied: (path, authorization, body) => {
        if (path === "/capabilities/v1/renew")
          copied.resolve({ token: authorization.slice("Bearer ".length), body })
      },
    })
    await inDirectory("relay-replay-", (root) =>
      withRelayOfRun(f, gateway, root, 500, async ({ runner, grant, child, call }) => {
        const request = await copied.promise
        expect(request.token).toBe(grant.token)
        await renewals.reach(1)
        const successors = () =>
          f.gatewaySql(
            (sql) => sql`SELECT digest FROM capability_tokens WHERE predecessor IS NOT NULL`,
          )
        const before = await successors()
        expect(before).toHaveLength(1)
        const mints = await f.mints()
        const replay = async () => {
          expect((await runner.renewWith(request.token, request.body)).status).toBe(403)
          expect(await f.mints()).toBe(mints)
          expect(await successors()).toEqual(before)
          await runGoesOn(f, child)
        }
        await replay()
        const answer = await call()
        expect([answer.status, await answer.text()]).toEqual([200, sse])
        await replay()
        const again = await call()
        expect([again.status, await again.text()]).toEqual([200, sse])
        expect(renewals.statuses).toEqual([200, 403, 403])
      }),
    )
  })
}, 40000)

test("the relay's first renewal request, held at the front past the relay's timeout and delivered after its retry was taken and used, has no effect, and the relay goes on", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const renewals = renewalAnswers()
    const release = Promise.withResolvers<void>()
    let requests = 0
    f.front.hook({
      lost: (path, status) => {
        if (path === "/capabilities/v1/renew") renewals.record(status)
        return false
      },
      // The front reads each request whole: the first one reaches the gateway after its client
      // has gone.
      copied: () => undefined,
      held: (path) =>
        path === "/capabilities/v1/renew" && requests++ === 0 ? release.promise : undefined,
    })
    await inDirectory("relay-late-", (root) =>
      withRelayOfRun(f, gateway, root, 500, async ({ child, call }) => {
        await renewals.reach(1)
        expect(renewals.statuses).toEqual([200])
        const answer = await call()
        expect([answer.status, await answer.text()]).toEqual([200, sse])
        const mints = await f.mints()
        release.resolve()
        await renewals.reach(2)
        expect(renewals.statuses).toEqual([200, 403])
        expect(await f.mints()).toBe(mints)
        await runGoesOn(f, child)
        const again = await call()
        expect([again.status, await again.text()]).toEqual([200, sse])
      }),
    )
  })
}, 40000)

test("the relay asks again for a renewal whose answer the front dropped, gets a valid successor, and the dropped successor is refused", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const renewals = renewalAnswers()
    let dropped = ""
    f.front.hook({
      lost: (path, status) => {
        if (path !== "/capabilities/v1/renew") return false
        renewals.record(status)
        return renewals.statuses.length === 1
      },
      taken: (_, body) => {
        dropped = body
      },
    })
    await inDirectory("relay-dropped-", (root) =>
      withRelayOfRun(f, gateway, root, 500, async ({ runner, grant, child, call }) => {
        await renewals.reach(2)
        expect(renewals.statuses).toEqual([200, 200])
        const answer = await call()
        expect(answer.status).toBe(200)
        expect(await answer.text()).toBe(sse)
        expect(
          (await runner.call((await runner.grant(Response.json(JSON.parse(dropped)))).token))
            .status,
        ).toBe(403)
        expect((await runner.call(grant.token)).status).toBe(403)
        await runGoesOn(f, child)
      }),
    )
  })
}, 40000)

test("when a second client makes a call with the successor that the front took from the relay, the relay's next renewal ends the run: both tokens are refused, the open stream ends on the revoke, and the end reason is two holders", async () => {
  // The sweep of stale streams runs at the gateway's start and then after the test's time limit:
  // only the revoke can end the held stream.
  await withGateway(
    processGateway,
    async (f, gateway) => {
      const renewals = renewalAnswers()
      const taken = Promise.withResolvers<string>()
      const used = Promise.withResolvers<void>()
      f.front.hook({
        lost: (path, status) => {
          if (path !== "/capabilities/v1/renew") return false
          renewals.record(status)
          return renewals.statuses.length === 1
        },
        taken: (_, body) => taken.resolve(body),
        // The relay's next renewal reaches the gateway once the second client's stream is open.
        held: (path) =>
          path === "/capabilities/v1/renew" && renewals.statuses.length > 0
            ? used.promise
            : undefined,
      })
      const release = f.holdStream()
      await inDirectory("relay-two-holders-", (root) =>
        withRelayOfRun(f, gateway, root, 500, async ({ runner, grant, child }) => {
          const successor = (await runner.grant(Response.json(JSON.parse(await taken.promise))))
            .token
          const second = client(gateway, sessionKeyPair())
          const stream = await second.call(successor)
          expect(stream.status).toBe(200)
          const reader = stream.body!.getReader()
          expect((await reader.read()).done).toBe(false)
          const ended = (async () => {
            try {
              for (let item = await reader.read(); !item.done; item = await reader.read());
              return "ended"
            } catch {
              return "cut"
            }
          })()
          used.resolve()
          expect(await child.exited).toBe(0)
          expect(renewals.statuses).toEqual([200, 403])
          expect(await readFile(join(root, "relay-ended"), "utf8")).toBe("renewal\n")
          expect(await ended).toBe("cut")
          expect((await second.call(successor)).status).toBe(403)
          expect((await runner.call(grant.token)).status).toBe(403)
          expect(
            await f.gatewaySql(
              (sql) =>
                sql`SELECT revoked,end_reason AS endReason FROM capability_grants WHERE run_id='run'`,
            ),
          ).toEqual([{ revoked: 1, endReason: "two holders" }])
        }),
      )
      release()
    },
    { staleSweepMs: 60000 },
  )
}, 40000)

test("through the relay, a model call of a run whose budget is spent gets the budget body; the daemon reads the budget spent, and the run token still renews", async () => {
  await withGateway(
    processGateway,
    async (f, gateway) => {
      const renewals = renewalAnswers()
      const spent = Promise.withResolvers<void>()
      // The relay's renewal reaches the gateway only once the run's budget is spent.
      f.front.hook({
        lost: (path, status) => {
          if (path === "/capabilities/v1/renew") renewals.record(status)
          return false
        },
        held: (path) => (path === "/capabilities/v1/renew" ? spent.promise : undefined),
      })
      await inDirectory("relay-budget-", (root) =>
        withRelayOfRun(f, gateway, root, 500, async ({ call }) => {
          const served = await call()
          expect([served.status, await served.text()]).toEqual([200, sse])
          const refused = await call()
          expect(refused.status).toBe(403)
          expect(await refused.json()).toEqual({
            type: "error",
            error: { type: "permission_error", message: "workflowd run budget spent" },
          })
          expect(
            await f.gatewaySql(
              (sql) =>
                sql`SELECT calls,output_tokens AS outputTokens,spent FROM capability_usage WHERE run_id='run'`,
            ),
          ).toEqual([{ calls: 1, outputTokens: 1, spent: 1 }])
          spent.resolve()
          await renewals.reach(1)
          expect(renewals.statuses[0]).toBe(200)
          expect(f.upstreamRequests().length).toBe(1)
        }),
      )
    },
    {},
    { calls: 1, outputTokens: 1000, maxTokens: 400 },
  )
}, 40000)
