import { expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { TestClock } from "effect/testing"
import { handleGitHubWebhook, routeRequest } from "../src/http"
import { signedRequest } from "./github-webhook"
import { allowed, fixture, installation, storeLayer, timed } from "./helpers/installation-guard"

for (const [event, action] of [
  ["installation", "created"],
  ["installation", "unsuspend"],
  ["installation", "new_permissions_accepted"],
  ["installation_repositories", "added"],
]) {
  test(`${event}.${action} checks null-account payloads through GitHub`, async () => {
    const f = fixture((method) =>
      method === "GET" ? Response.json(installation(10)) : new Response(null, { status: 204 }),
    )
    const response = await Effect.runPromise(
      handleGitHubWebhook(
        signedRequest(
          event!,
          JSON.stringify({ action, installation: { id: 10, account: null } }),
          "null-account",
          "secret",
        ),
        {
          webhookSecret: "secret",
          now: new Date(),
          installationIds: new Set(),
          installationGuard: f.guard,
        },
      ).pipe(f.background, Effect.provide(storeLayer), Effect.provide(f.logger)),
    )
    expect(response.status).toBe(202)
    expect(f.requests).toEqual(["GET /app/installations/10", "DELETE /app/installations/10"])
  })
}

test.each(["User", "Organization", "Enterprise", "Bot", undefined])(
  "only User and Organization can be allowed: %s",
  async (type) => {
    const value = { id: 10, account: { id: allowed[0], type } }
    const f = fixture((method) =>
      method === "GET" ? Response.json([value]) : new Response(null, { status: 204 }),
    )
    await Effect.runPromise(f.guard.reconcile().pipe(Effect.provide(f.logger)))
    expect(f.requests.filter((r) => r.startsWith("DELETE"))).toHaveLength(
      type === "User" || type === "Organization" ? 0 : 1,
    )
  },
)

test("undecodable reconciled installations are counted and prevent successful health", async () => {
  let malformed = true
  const f = fixture(() =>
    Response.json(malformed ? [{ id: 10, account: null }, { id: "invalid" }] : []),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* f.guard.reconcile()).toBe(false)
      expect(yield* f.guard.health()).toMatchObject({
        undecodableInstallations: 2,
        status: "degraded",
        lastSuccessfulReconciliationAt: null,
      })
      malformed = false
      expect(yield* f.guard.reconcile()).toBe(true)
      expect(yield* f.guard.health()).toMatchObject({ undecodableInstallations: 0, status: "ok" })
    }).pipe(Effect.provide(f.logger)),
  )
})

test("403 with remaining quota and a reset header is not retried", async () => {
  const f = fixture(() =>
    Response.json(
      {},
      { status: 403, headers: { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1" } },
    ),
  )
  await Effect.runPromise(
    timed((sleeps) =>
      Effect.gen(function* () {
        const result = yield* Effect.race(
          f.guard.reconcile().pipe(Effect.result, Effect.as("failed")),
          Queue.take(sleeps).pipe(Effect.as("retried")),
        )
        expect(result).toBe("failed")
        expect(f.requests).toHaveLength(1)
      }),
    ),
  )
})

test("health degrades after twice the maximum reconciliation backoff and recovers", async () => {
  const f = fixture(() => Response.json([]))
  await Effect.runPromise(
    timed(() =>
      Effect.gen(function* () {
        yield* f.guard.reconcile()
        yield* TestClock.adjust("2 hours")
        expect(yield* f.guard.health()).toMatchObject({ status: "ok" })
        yield* TestClock.adjust("1 milli")
        const response = yield* routeRequest(new Request("http://localhost/health"), {
          webhookSecret: "secret",
          now: new Date(),
          installationIds: new Set(),
          installationGuard: f.guard,
        })
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          status: "degraded",
          installationGuard: { status: "degraded", lastSuccessfulReconciliationAt: 0 },
        })
        yield* f.guard.reconcile()
        expect(yield* f.guard.health()).toMatchObject({
          status: "ok",
          lastSuccessfulReconciliationAt: 7200001,
        })
      }),
    ).pipe(Effect.provide(storeLayer)),
  )
})
