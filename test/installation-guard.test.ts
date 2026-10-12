import { expect, test } from "bun:test"
import { createHmac, generateKeyPairSync } from "node:crypto"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Clock, Duration, Effect, Fiber, Layer, Logger, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeInstallationGuard, startInstallationGuard } from "../src/installation-guard"
import { handleGitHubWebhook } from "../src/http"
import { WorkflowStoreLive } from "../src/store"
import { WorkSignalLive } from "../src/work-signal"

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const allowed = [81005232, 319835875]
const installation = (id: number, accountId = 999) => ({
  id,
  account: { id: accountId, login: "renamed-account" },
})
const storeLayer = Layer.merge(
  WorkflowStoreLive.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
  WorkSignalLive,
)

function fixture(
  respond: (method: string, url: URL) => Response | Promise<Response> = () =>
    new Response(null, { status: 204 }),
) {
  const requests: string[] = []
  const auth: string[] = []
  const logs: string[] = []
  const app = new App({
    appId: 123,
    privateKey,
    Octokit: Octokit.defaults({
      request: {
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input)
          const method = init?.method ?? "GET"
          requests.push(`${method} ${url.pathname}${url.search}`)
          auth.push(new Headers(init?.headers).get("authorization") ?? "")
          return respond(method, url)
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }),
  })
  return {
    guard: makeInstallationGuard(allowed, app.octokit),
    requests,
    auth,
    logs,
    logger: Logger.layer([
      Logger.make(({ message }) => {
        logs.push(String(message))
      }),
    ]),
  }
}

function webhook(
  event: string,
  action: string,
  accountId: number,
  deliveryId = "delivery-1",
  signed = true,
) {
  const body = JSON.stringify({ action, installation: installation(10, accountId) })
  return new Request("http://localhost/hooks/github", {
    method: "POST",
    body,
    headers: {
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", signed ? "secret" : "wrong")
        .update(body)
        .digest("hex")}`,
    },
  })
}

for (const [event, action] of [
  ["installation", "created"],
  ["installation", "new_permissions_accepted"],
  ["installation_repositories", "added"],
] as const) {
  test.each([999, ...allowed])(
    `${event}/${action} guards account %s and deduplicates concurrent deliveries`,
    async (accountId) => {
      const f = fixture()
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* Effect.forEach(
            [1, 2],
            () =>
              handleGitHubWebhook(webhook(event, action, accountId), {
                webhookSecret: "secret",
                now: new Date(),
                installationGuard: f.guard,
              }),
            { concurrency: "unbounded" },
          )
        }).pipe(Effect.provide(storeLayer), Effect.provide(f.logger)),
      )
      expect(results.map((r) => r.status)).toEqual([202, 202])
      const bodies = await Promise.all(results.map((r) => r.json()))
      expect(bodies).toContainEqual({ status: "duplicate" })
      expect(bodies).toContainEqual({ status: accountId === 999 ? "uninstalled" : "allowed" })
      expect(f.requests).toEqual(accountId === 999 ? ["DELETE /app/installations/10"] : [])
      expect(f.logs).toHaveLength(1)
      expect(f.logs[0]).toContain('"installationId":10')
      expect(f.logs[0]).toContain(`"accountId":${accountId}`)
      expect(f.logs[0]).toContain('"login":"renamed-account"')
      if (accountId === 999) expect(f.auth[0]).toMatch(/^bearer ey[^.]+\.[^.]+\.[^.]+$/i)
    },
  )
}

test("unsigned deliveries cannot invoke the guard", async () => {
  const f = fixture()
  const response = await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "created", 999, "bad", false), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(Effect.provide(storeLayer)),
  )
  expect(response.status).toBe(401)
  expect(f.requests).toEqual([])
})

test("other installation actions remain ignored", async () => {
  const f = fixture()
  const response = await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "deleted", 999), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(Effect.provide(storeLayer)),
  )
  expect(response.status).toBe(202)
  expect(f.requests).toEqual([])
})

test("DELETE 404 is already gone", async () => {
  const f = fixture(() => Response.json({ message: "Not Found" }, { status: 404 }))
  const response = await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "created", 999), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
  expect(await response.json()).toEqual({ status: "already_gone" })
  expect(f.requests).toHaveLength(1)
  expect(f.logs[0]).toContain('"outcome":"already_gone"')
})

// Synchronize on scheduled sleeps: App JWT signing and fetch are asynchronous,
// so advancing TestClock alone can race a request that has not returned yet.
function timed<A, E, R>(run: (sleeps: Queue.Queue<Duration.Duration>) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const clock = yield* Effect.clockWith(Effect.succeed)
    const sleeps = yield* Queue.unbounded<Duration.Duration>()
    return yield* run(sleeps).pipe(
      Effect.provideService(Clock.Clock, {
        ...clock,
        sleep: (duration) =>
          (Duration.toMillis(duration) === 10_000
            ? Effect.void
            : Queue.offer(sleeps, duration)
          ).pipe(Effect.andThen(clock.sleep(duration))),
      }),
    )
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()))
}

test("startup and periodic reconciliation paginate before deleting and preserve allowed accounts", async () => {
  let scans = 0
  const f = fixture((method, url) => {
    if (method === "DELETE") return new Response(null, { status: 204 })
    if (url.searchParams.get("page") === "1") {
      scans++
      return Response.json([installation(1, allowed[0]), installation(2)], {
        headers: {
          link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"',
        },
      })
    }
    return Response.json([installation(3, allowed[1]), installation(4)])
  })
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        yield* startInstallationGuard(f.guard)
        expect(scans).toBe(1)
        expect(f.requests).toEqual([
          "GET /app/installations?per_page=100&page=1",
          "GET /app/installations?per_page=100&page=2",
          "DELETE /app/installations/2",
          "DELETE /app/installations/4",
        ])
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(600000)
        yield* TestClock.adjust("9 minutes")
        expect(scans).toBe(1)
        yield* TestClock.adjust("1 minute")
        yield* Queue.take(sleeps)
        expect(scans).toBe(2)
        yield* TestClock.adjust("10 minutes")
        yield* Queue.take(sleeps)
        expect(scans).toBe(3)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
  expect(f.requests.filter((r) => r.startsWith("DELETE"))).toEqual([
    "DELETE /app/installations/2",
    "DELETE /app/installations/4",
    "DELETE /app/installations/2",
    "DELETE /app/installations/4",
    "DELETE /app/installations/2",
    "DELETE /app/installations/4",
  ])
})

test("transient DELETE failures back off then succeed with one terminal audit", async () => {
  let attempts = 0
  const f = fixture((method) =>
    method === "GET"
      ? Response.json([installation(10)])
      : ++attempts < 3
        ? Response.json({}, { status: 503 })
        : new Response(null, { status: 204 }),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.guard.reconcile())
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(1000)
        yield* TestClock.adjust("999 millis")
        expect(attempts).toBe(1)
        yield* TestClock.adjust("1 millis")
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(2000)
        expect(attempts).toBe(2)
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(fiber)
        expect(attempts).toBe(3)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
  expect(f.logs).toHaveLength(1)
})

test("exhausted failures are bounded and the next reconciliation recovers", async () => {
  let failing = true
  const f = fixture((method) =>
    method === "GET"
      ? Response.json([installation(10)])
      : failing
        ? Response.json({}, { status: 502 })
        : new Response(null, { status: 204 }),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(startInstallationGuard(f.guard))
        for (const delay of [1000, 2000, 4000]) {
          expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(delay)
          yield* TestClock.adjust(delay)
        }
        yield* Fiber.join(fiber)
        expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(4)
        expect(f.logs.some((log) => log.includes('"outcome":"failed"'))).toBe(true)
        yield* Queue.take(sleeps)
        failing = false
        yield* TestClock.adjust("10 minutes")
        yield* Queue.take(sleeps)
        expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(5)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
})

test.each([[], [81005232, 81005232], [81005232, NaN], [81005232, -1]].map((ids) => ({ ids })))(
  "invalid programmatic policy refuses construction: %j",
  ({ ids }) => {
    const app = new App({ appId: 123, privateKey })
    expect(() => makeInstallationGuard(ids, app.octokit)).toThrow(
      "WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS",
    )
  },
)

test("a failed delivery stays deduplicated and reconciliation recovers it", async () => {
  let failing = true
  const f = fixture((method) =>
    method === "GET"
      ? Response.json([installation(10)])
      : failing
        ? Response.json({}, { status: 403 })
        : new Response(null, { status: 204 }),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const send = () =>
        handleGitHubWebhook(webhook("installation", "created", 999), {
          webhookSecret: "secret",
          now: new Date(),
          installationGuard: f.guard,
        })
      expect((yield* send()).status).toBe(500)
      const duplicate = yield* send()
      expect(yield* Effect.promise(() => duplicate.json())).toEqual({ status: "duplicate" })
      expect(f.requests).toEqual(["DELETE /app/installations/10"])
      failing = false
      yield* f.guard.reconcile()
      expect(f.requests.at(-1)).toBe("DELETE /app/installations/10")
    }).pipe(Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
})

test("a failed list retries with backoff before a complete reconciliation", async () => {
  let lists = 0
  const f = fixture((method) =>
    method === "GET"
      ? ++lists === 1
        ? Response.json({}, { status: 429 })
        : Response.json([installation(10)])
      : new Response(null, { status: 204 }),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.guard.reconcile())
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(1000)
        expect(f.requests).toHaveLength(1)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
  expect(f.requests).toEqual([
    "GET /app/installations?per_page=100&page=1",
    "GET /app/installations?per_page=100&page=1",
    "DELETE /app/installations/10",
  ])
})

test("malformed API account data never authorizes deletion", async () => {
  const f = fixture(() =>
    Response.json([installation(10), { id: 20, account: { id: "81005232", login: "allowed" } }]),
  )
  const result = await Effect.runPromise(f.guard.reconcile().pipe(Effect.exit))
  expect(result._tag).toBe("Failure")
  expect(f.requests).toEqual(["GET /app/installations?per_page=100&page=1"])
})

test("list failure at startup is logged and retried on the next periodic pass", async () => {
  let failing = true
  const f = fixture((method) =>
    method === "GET"
      ? failing
        ? Response.json({}, { status: 401 })
        : Response.json([installation(10)])
      : new Response(null, { status: 204 }),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        yield* startInstallationGuard(f.guard)
        yield* Queue.take(sleeps)
        expect(f.logs.some((log) => log.includes("Installation reconciliation failed"))).toBe(true)
        failing = false
        yield* TestClock.adjust("10 minutes")
        yield* Queue.take(sleeps)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
  expect(f.requests.at(-1)).toBe("DELETE /app/installations/10")
})

test("a stalled API request times out and retries instead of blocking reconciliation", async () => {
  const started = Promise.withResolvers<void>()
  const f = fixture(() => {
    started.resolve()
    return new Promise<Response>(() => {})
  })
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.guard.reconcile())
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust("10 seconds")
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(1000)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
})

test("GitHub's 403 rate limit response backs off and retries", async () => {
  let lists = 0
  const f = fixture(() =>
    ++lists === 1
      ? Response.json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } })
      : Response.json([]),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.guard.reconcile())
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(1000)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)
      }),
    ).pipe(Effect.provide(f.logger)),
  )
  expect(lists).toBe(2)
})
