import { expect, test } from "bun:test"
import { App } from "@octokit/app"
import { Duration, Effect, Fiber, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeInstallationGuard, startInstallationGuard } from "../src/installation-guard"
import { handleGitHubWebhook, routeRequest } from "../src/http"
import {
  allowed,
  fixture,
  installation,
  privateKey,
  storeLayer,
  timed,
  webhook,
} from "./helpers/installation-guard"

for (const [event, action] of [
  ["installation", "created"],
  ["installation", "unsuspend"],
  ["installation", "new_permissions_accepted"],
  ["installation_repositories", "added"],
] as const) {
  test.each([999, ...allowed])(
    `${event}/${action} guards account %s and deduplicates concurrent deliveries`,
    async (accountId) => {
      const f = fixture((method) =>
        method === "GET"
          ? Response.json(installation(10, accountId))
          : new Response(null, { status: 204 }),
      )
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
        }).pipe(f.background, Effect.provide(storeLayer), Effect.provide(f.logger)),
      )
      expect(results.map((r) => r.status)).toEqual([202, 202])
      const bodies = await Promise.all(results.map((r) => r.json()))
      expect(bodies).toContainEqual({ status: "duplicate" })
      expect(bodies).toContainEqual({ status: "accepted" })
      expect(f.requests).toEqual(
        accountId === 999
          ? ["GET /app/installations/10", "DELETE /app/installations/10"]
          : ["GET /app/installations/10"],
      )
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

test("GET 404 is already gone", async () => {
  const f = fixture(() => Response.json({ message: "Not Found" }, { status: 404 }))
  const response = await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "created", 999), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(f.background, Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
  expect(await response.json()).toEqual({ status: "accepted" })
  expect(f.requests).toHaveLength(1)
  expect(f.logs[0]).toContain('"outcome":"already_gone"')
})

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
        expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(600000)
        expect(scans).toBe(1)
        expect(f.requests).toEqual([
          "GET /app/installations?per_page=100&page=1",
          "GET /app/installations?per_page=100&page=2",
          "DELETE /app/installations/2",
          "DELETE /app/installations/4",
        ])
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
        yield* startInstallationGuard(f.guard)
        for (const delay of [1000, 2000, 4000]) {
          expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(delay)
          yield* TestClock.adjust(delay)
        }
        yield* Queue.take(sleeps)
        expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(4)
        expect(f.logs.some((log) => log.includes('"outcome":"failed"'))).toBe(true)
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
    expect(() => Effect.runSync(makeInstallationGuard(ids, app.octokit))).toThrow(
      "WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS",
    )
  },
)

test("a failed delivery stays deduplicated and reconciliation recovers it", async () => {
  let failing = true
  const f = fixture((method, url) =>
    method === "GET"
      ? Response.json(url.search ? [installation(10)] : installation(10))
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
      yield* f.guard.runWebhooks.pipe(Effect.forkScoped)
      expect((yield* send()).status).toBe(202)
      yield* f.nextLog
      const duplicate = yield* send()
      expect(yield* Effect.promise(() => duplicate.json())).toEqual({ status: "duplicate" })
      expect(f.requests).toEqual(["GET /app/installations/10", "DELETE /app/installations/10"])
      failing = false
      yield* f.guard.reconcile()
      expect(f.requests.at(-1)).toBe("DELETE /app/installations/10")
    }).pipe(Effect.scoped, Effect.provide(storeLayer), Effect.provide(f.logger)),
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

test("malformed and null accounts are skipped while foreign and enterprise accounts are removed", async () => {
  const f = fixture((method) =>
    method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json([
          { id: 20, account: { id: "81005232", login: "allowed" } },
          { id: 21, account: null },
          installation(10),
          { id: 22, account: { id: 777, slug: "enterprise" } },
          { id: 23, account: { id: allowed[0], slug: "allowed-enterprise" } },
        ]),
  )
  await Effect.runPromise(f.guard.reconcile().pipe(Effect.provide(f.logger)))
  expect(f.requests).toEqual([
    "GET /app/installations?per_page=100&page=1",
    "DELETE /app/installations/10",
    "DELETE /app/installations/22",
  ])
  expect(f.logs.filter((line) => line.includes('"outcome":"undecodable"'))).toHaveLength(2)
})

test("a foreign payload account never deletes an installation GitHub says is allowed", async () => {
  const f = fixture(() => Response.json(installation(10, allowed[0])))
  await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "created", 999), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(f.background, Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
  expect(f.requests).toEqual(["GET /app/installations/10"])
  expect(f.logs[0]).toContain('"outcome":"account_mismatch_allowed"')
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

test("startup returns while GitHub is stalled", async () => {
  const f = fixture(() => new Promise<Response>(() => {}))
  await Effect.runPromise(
    timed(() =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.race(
            startInstallationGuard(f.guard).pipe(Effect.as("started")),
            Effect.sleep("1 second").pipe(Effect.as("blocked")),
          ),
        )
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toBe("started")
      }),
    ),
  )
})

test("webhooks return 202 without waiting for GitHub and retain their delivery claim", async () => {
  const f = fixture(() => new Promise<Response>(() => {}))
  await Effect.runPromise(
    timed(() =>
      Effect.gen(function* () {
        const send = () =>
          handleGitHubWebhook(webhook("installation", "created", 999), {
            webhookSecret: "secret",
            now: new Date(),
            installationGuard: f.guard,
          })
        const fiber = yield* Effect.forkChild(
          Effect.race(
            send().pipe(Effect.map((r) => r.status)),
            Effect.sleep("1 second").pipe(Effect.as(0)),
          ),
        )
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toBe(202)
        const duplicate = yield* send()
        expect(yield* Effect.promise(() => duplicate.json())).toEqual({ status: "duplicate" })
      }),
    ).pipe(Effect.provide(storeLayer)),
  )
})

for (const [headers, delay] of [
  [{ "retry-after": "17" }, 17000],
  [{ "retry-after": "9999" }, 60000],
  [{ "x-ratelimit-reset": "25" }, 25000],
  [{ "retry-after": "Thu, 01 Jan 1970 00:00:30 GMT" }, 30000],
  [{ "retry-after": "invalid" }, 1000],
] as const) {
  test(`retry respects bounded GitHub delay ${JSON.stringify(headers)}`, async () => {
    let attempts = 0
    const f = fixture(() =>
      ++attempts === 1 ? Response.json({}, { status: 403, headers }) : Response.json([]),
    )
    await Effect.runPromise(
      timed((sleeps) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(f.guard.reconcile())
          expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(delay)
          yield* TestClock.adjust(delay)
          yield* Fiber.join(fiber)
          expect(attempts).toBe(2)
        }),
      ),
    )
  })
}

test("background defects and failures back off, recover, and update health only after success", async () => {
  let passes = 0
  const f = fixture(() => (passes === 2 ? Response.json({}, { status: 401 }) : Response.json([])))
  const guard = {
    ...f.guard,
    reconcile: () =>
      Effect.suspend(() => {
        passes++
        if (passes === 1) return Effect.die("broken adapter")
        return f.guard.reconcile()
      }),
  }
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        yield* startInstallationGuard(guard)
        for (const delay of [600000, 1200000, 600000]) {
          expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(delay)
          const response = yield* routeRequest(new Request("http://localhost/health"), {
            webhookSecret: "secret",
            now: new Date(),
            installationGuard: f.guard,
          })
          expect(yield* Effect.promise(() => response.json())).toEqual({
            status: "ok",
            installationGuard: { lastSuccessfulReconciliationAt: passes < 3 ? null : 1800000 },
          })
          if (passes < 3) yield* TestClock.adjust(delay)
        }
        expect(
          f.logs.filter((line) => line.includes("Installation reconciliation failed")),
        ).toHaveLength(2)
      }),
    ).pipe(Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
})

test("DELETE 404 after a verified foreign installation is already gone", async () => {
  const f = fixture((method) =>
    method === "GET" ? Response.json(installation(10)) : Response.json({}, { status: 404 }),
  )
  await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "created", 999), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(f.background, Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
  expect(f.requests).toEqual(["GET /app/installations/10", "DELETE /app/installations/10"])
  expect(f.logs[0]).toContain('"outcome":"already_gone"')
})

test("undecodable webhook lookup is audited without deleting", async () => {
  const f = fixture(() => Response.json({ id: 10, account: null }))
  await Effect.runPromise(
    handleGitHubWebhook(webhook("installation", "created", 999), {
      webhookSecret: "secret",
      now: new Date(),
      installationGuard: f.guard,
    }).pipe(f.background, Effect.provide(storeLayer), Effect.provide(f.logger)),
  )
  expect(f.requests).toEqual(["GET /app/installations/10"])
  expect(f.logs[0]).toContain('"outcome":"undecodable"')
})

test("failed removals back off to an hour and preserve the last successful time", async () => {
  let failing = false
  const f = fixture((method) =>
    method === "GET"
      ? Response.json([installation(10)])
      : new Response(null, { status: failing ? 401 : 204 }),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        yield* startInstallationGuard(f.guard)
        yield* Queue.take(sleeps)
        expect(yield* f.guard.health()).toEqual({ lastSuccessfulReconciliationAt: 0 })
        failing = true
        let previous = 600000
        for (const delay of [600000, 1200000, 2400000, 3600000, 3600000]) {
          yield* TestClock.adjust(previous)
          expect(Duration.toMillis(yield* Queue.take(sleeps))).toBe(delay)
          expect(yield* f.guard.health()).toEqual({ lastSuccessfulReconciliationAt: 0 })
          previous = delay
        }
      }),
    ).pipe(Effect.provide(f.logger)),
  )
})
