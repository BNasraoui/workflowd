import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { handleGitHubWebhook, routeRequest } from "../src/http"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore } from "../src/store/contracts"

const DatabaseLive = SqliteClient.layer({ filename: ":memory:" })
const TestLayer = WorkflowStoreLive.pipe(Layer.provide(DatabaseLive))

const payload = JSON.stringify({
  action: "opened",
  installation: { id: 91 },
  repository: {
    id: 42,
    full_name: "example-owner/example",
    owner: { login: "example-owner" },
    name: "example",
  },
  pull_request: {
    number: 7,
    draft: false,
    state: "open",
    user: { login: "opencode-agent" },
    head: {
      sha: "a".repeat(40),
      ref: "opencode/example-job",
      repo: { full_name: "example-owner/example" },
    },
    base: { sha: "d".repeat(40), ref: "main" },
  },
})

describe("handleGitHubWebhook", () => {
  test("verifies and durably enqueues a pull request delivery", async () => {
    const secret = "webhook-secret"
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`
    const request = new Request("http://localhost/hooks/github", {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-http-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* handleGitHubWebhook(request, {
          webhookSecret: secret,
          now: new Date("2026-07-19T12:00:00.000Z"),
        })
        const store = yield* WorkflowStore
        const job = yield* store.claimNextJob({
          workerId: "worker-1",
          now: new Date("2026-07-19T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { body: yield* Effect.promise(() => response.json()), job, response }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.response.status).toBe(202)
    expect(result.body).toEqual({ status: "enqueued", generation: 1 })
    expect(String(result.job?.target.headSha)).toBe("a".repeat(40))
  })

  test("rejects a webhook body above the configured limit", async () => {
    const secret = "webhook-secret"
    const oversized = JSON.stringify({ action: "opened", padding: "x".repeat(200) })
    const signature = `sha256=${createHmac("sha256", secret).update(oversized).digest("hex")}`
    const request = new Request("http://localhost/hooks/github", {
      method: "POST",
      body: oversized,
      headers: {
        "x-github-delivery": "delivery-http-large",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
    })

    const response = await Effect.runPromise(
      handleGitHubWebhook(request, {
        webhookSecret: secret,
        now: new Date("2026-07-19T12:00:00.000Z"),
        maxBodyBytes: 100,
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(413)
  })

  test("returns 400 for a malformed pull request domain identifier", async () => {
    const secret = "webhook-secret"
    const malformedPayload = JSON.stringify({
      ...JSON.parse(payload),
      pull_request: { ...JSON.parse(payload).pull_request, number: 0 },
    })
    const signature = `sha256=${createHmac("sha256", secret).update(malformedPayload).digest("hex")}`
    const request = new Request("http://localhost/hooks/github", {
      method: "POST",
      body: malformedPayload,
      headers: {
        "x-github-delivery": "delivery-http-invalid-id",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
    })

    const response = await Effect.runPromise(
      handleGitHubWebhook(request, {
        webhookSecret: secret,
        now: new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(400)
  })

  test("returns 400 for a malformed command domain identifier", async () => {
    const secret = "webhook-secret"
    const malformedPayload = JSON.stringify({
      action: "created",
      installation: { id: 91 },
      repository: JSON.parse(payload).repository,
      issue: {
        number: 7,
        pull_request: { url: "https://api.github.test/pr/7" },
      },
      comment: {
        id: 0,
        body: "/agent review",
        user: { login: "example-owner" },
      },
    })
    const signature = `sha256=${createHmac("sha256", secret).update(malformedPayload).digest("hex")}`
    const request = new Request("http://localhost/hooks/github", {
      method: "POST",
      body: malformedPayload,
      headers: {
        "x-github-delivery": "delivery-http-invalid-command-id",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
    })

    const response = await Effect.runPromise(
      handleGitHubWebhook(request, {
        webhookSecret: secret,
        now: new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(400)
  })
})

describe("routeRequest", () => {
  test("serves local health without touching the webhook store", async () => {
    const response = await Effect.runPromise(
      routeRequest(new Request("http://localhost/health"), {
        webhookSecret: "secret",
        now: new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })
})
