import { createHmac, generateKeyPairSync } from "node:crypto"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Clock, Duration, Effect, Layer, Logger, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeInstallationGuard } from "../../src/installation-guard"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignalLive } from "../../src/work-signal"

export const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
export const allowed = [81005232, 319835875]
export const installation = (id: number, accountId = 999) => ({
  id,
  account: { id: accountId, login: "renamed-account", type: "User" },
})
export const storeLayer = Layer.merge(
  WorkflowStoreLive.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
  WorkSignalLive,
)

export function fixture(
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
  const guard = Effect.runSync(makeInstallationGuard(allowed, app.octokit))
  const lines = Effect.runSync(Queue.unbounded<string>())
  return {
    guard,
    requests,
    auth,
    logs,
    nextLog: Queue.take(lines),
    background: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* guard.runWebhooks.pipe(Effect.forkScoped)
          const result = yield* effect
          yield* Queue.take(lines)
          return result
        }),
      ),
    logger: Logger.layer([
      Logger.make(({ message }) => {
        logs.push(String(message))
        Queue.offerUnsafe(lines, String(message))
      }),
    ]),
  }
}

export function webhook(
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

// Observe scheduled sleeps before advancing TestClock: JWT signing and fetch are asynchronous.
export function timed<A, E, R>(
  run: (sleeps: Queue.Queue<Duration.Duration>) => Effect.Effect<A, E, R>,
) {
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
