import { createHmac } from "node:crypto"
import { handleGitHubWebhook } from "../../src/http"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignalLive } from "../../src/work-signal"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { makeCiStore } from "../../src/ci/store"
import { runStoreMigrations } from "../../src/store/migrations"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { routeCi } from "../../src/ci/http"

test("wait API refuses unauthorized and unconfigured targets", async () => {
  const service = {
    token: "test-token",
    repositories: [{ repository: "o/r", installationId: 1, workflows: ["CI"] }],
  }
  expect(
    (
      await Effect.runPromise(
        routeCi(
          new Request("http://localhost/ci/state?repo=o/r&sha=" + "a".repeat(40)),
          service,
          undefined,
        ),
      )
    )?.status,
  ).toBe(401)
  expect(
    (
      await Effect.runPromise(
        routeCi(
          new Request("http://localhost/ci/state?repo=other/r&sha=" + "a".repeat(40), {
            headers: { authorization: "Bearer test-token" },
          }),
          service,
          undefined,
        ),
      )
    )?.status,
  ).toBe(403)
})

test("state registration and replay are durable and scoped to exact SHA", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeCiStore
      const config = {
        token: "test-token",
        repositories: [{ repository: "o/r", installationId: 1, workflows: ["CI"] }],
      }
      const target = { repository: "o/r", sha: "a".repeat(40) }
      const request = (path: string) =>
        new Request(`http://localhost${path}?repo=o/r&sha=${target.sha}&after=0`, {
          headers: { authorization: "Bearer test-token" },
        })
      const state = yield* routeCi(request("/ci/state"), config, store)
      expect(yield* Effect.promise(() => state!.json())).toMatchObject({
        sequence: 0,
        conclusion: "pending",
      })
      yield* store.snapshot(
        target,
        [
          {
            id: 1,
            name: "CI",
            attempt: 1,
            status: "completed",
            conclusion: "success",
            failingJobs: [],
          },
        ],
        null,
        0,
      )
      const events = yield* routeCi(request("/ci/events"), config, store)
      expect(yield* Effect.promise(() => events!.json())).toMatchObject([
        { sequence: 1, conclusion: "success" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))

test("disabled CI keeps legacy ignored-event handling even for non-CI payloads", async () => {
  const body = "{}"
  const request = new Request("http://localhost/hooks/github", {
    method: "POST",
    body,
    headers: {
      "x-github-event": "workflow_run",
      "x-github-delivery": "disabled",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
    },
  })
  const response = await Effect.runPromise(
    handleGitHubWebhook(request, { webhookSecret: "secret", now: new Date() }).pipe(
      Effect.provide(
        Layer.merge(
          WorkflowStoreLive.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
          WorkSignalLive,
        ),
      ),
    ),
  )
  expect(response.status).toBe(202)
})
