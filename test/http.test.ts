import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Logger, Queue } from "effect"
import { handleGitHubWebhook, routeRequest } from "../src/http"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore, type WorkflowStorePort } from "../src/store/contracts"
import { WorkSignal, WorkSignalLive, type WorkSignalPort } from "../src/work-signal"
import { TicketSourceError } from "../src/qrspi/ports"
import { QrspiStoreDataError } from "../src/qrspi/store"
import { WorkflowStartValidationError } from "../src/qrspi/workflow-start"

const DatabaseLive = SqliteClient.layer({ filename: ":memory:" })
const TestLayer = Layer.merge(WorkflowStoreLive.pipe(Layer.provide(DatabaseLive)), WorkSignalLive)

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
        return {
          body: yield* Effect.promise(() => response.json()),
          job,
          response,
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.response.status).toBe(202)
    expect(result.body).toEqual({ status: "enqueued", generation: 1 })
    expect(String(result.job?.target.headSha)).toBe("a".repeat(40))
  })

  test("rejects a webhook body above the configured limit", async () => {
    const secret = "webhook-secret"
    const oversized = JSON.stringify({
      action: "opened",
      padding: "x".repeat(200),
    })
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

  test("returns 500 when the webhook body cannot be read", async () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logs.push({ level: logLevel.label, message })
    })
    class UnreadableRequest extends Request {
      override readonly arrayBuffer = (): Promise<ArrayBuffer> =>
        Promise.reject(new Error("body unavailable"))
    }

    const request = new UnreadableRequest("http://localhost/hooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-http-unreadable",
        "x-github-event": "pull_request",
      },
    })

    const response = await Effect.runPromise(
      handleGitHubWebhook(request, {
        webhookSecret: "webhook-secret",
        now: new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(
        Effect.provide(TestLayer),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "internal server error" })
    expect(logs).toEqual([
      {
        level: "ERROR",
        message: ["Webhook ingestion failed"],
      },
    ])
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

  test.each([
    ["enqueued", ["job", "reconciliation"]],
    ["reconciliation_enqueued", "reconciliation"],
    ["duplicate", undefined],
    ["ignored", "reconciliation"],
  ] as const)("wakes only for committed pull request disposition %s", async (status, lanes) => {
    const secret = "webhook-secret"
    const actions: Array<string> = []
    const request = signedRequest("pull_request", payload, `delivery-${status}`, secret)
    const layer = dispositionLayer(
      {
        ingestPullRequest: () =>
          Effect.sync(() => {
            actions.push(`commit:${status}`)
            return status === "duplicate" ? { status } : { status, generation: 1 }
          }),
      },
      actions,
    )

    const response = await Effect.runPromise(
      handleGitHubWebhook(request, {
        webhookSecret: secret,
        now: new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(Effect.provide(layer)),
    )

    expect(response.status).toBe(202)
    expect(actions).toEqual([
      `commit:${status}`,
      ...(lanes === undefined ? [] : typeof lanes === "string" ? [lanes] : lanes),
    ])
  })

  test("an accepted transition wakes and re-arms an existing reconciliation", async () => {
    const secret = "webhook-secret"
    const initialPayload = JSON.stringify({
      ...JSON.parse(payload),
      pull_request: { ...JSON.parse(payload).pull_request, updated_at: "2026-07-19T12:00:00.000Z" },
    })
    const ambiguousPayload = JSON.stringify({
      ...JSON.parse(initialPayload),
      action: "synchronize",
      pull_request: {
        ...JSON.parse(initialPayload).pull_request,
        head: { ...JSON.parse(initialPayload).pull_request.head, sha: "e".repeat(40) },
      },
    })
    const acceptedPayload = JSON.stringify({
      ...JSON.parse(ambiguousPayload),
      pull_request: {
        ...JSON.parse(ambiguousPayload).pull_request,
        updated_at: "2026-07-19T12:00:02.000Z",
        head: { ...JSON.parse(ambiguousPayload).pull_request.head, sha: "f".repeat(40) },
      },
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* handleGitHubWebhook(
            signedRequest("pull_request", initialPayload, "rearm-initial", secret),
            { webhookSecret: secret, now: new Date("2026-07-19T12:00:00.000Z") },
          )
          yield* handleGitHubWebhook(
            signedRequest("pull_request", ambiguousPayload, "rearm-ambiguous", secret),
            { webhookSecret: secret, now: new Date("2026-07-19T12:00:01.000Z") },
          )
          const store = yield* WorkflowStore
          const first = yield* store.claimNextReconciliation({
            workerId: "first-reconciler",
            now: new Date("2026-07-19T12:01:00.000Z"),
            leaseDurationMs: 60_000,
          })
          if (first === null) return yield* Effect.dieMessage("expected reconciliation")
          const signals = yield* WorkSignal
          const wake = yield* signals.subscribe("reconciliation")
          const response = yield* handleGitHubWebhook(
            signedRequest("pull_request", acceptedPayload, "rearm-accepted", secret),
            { webhookSecret: secret, now: new Date("2026-07-19T12:01:01.000Z") },
          )
          yield* Queue.take(wake)
          const rearmed = yield* store.claimNextReconciliation({
            workerId: "second-reconciler",
            now: new Date("2026-07-19T12:01:02.000Z"),
            leaseDurationMs: 60_000,
          })
          return { body: yield* Effect.promise(() => response.json()), first, rearmed }
        }).pipe(Effect.provide(TestLayer)),
      ),
    )

    expect(result.body).toEqual({ status: "enqueued", generation: 2 })
    expect(result.rearmed?.id).toBe(result.first.id)
  })

  test.each([
    ["enqueued", "command"],
    ["duplicate", undefined],
  ] as const)("wakes only for committed command disposition %s", async (status, lane) => {
    const secret = "webhook-secret"
    const actions: Array<string> = []
    const commandPayload = JSON.stringify({
      action: "created",
      installation: { id: 91 },
      repository: JSON.parse(payload).repository,
      issue: { number: 7, pull_request: { url: "https://api.github.test/pr/7" } },
      comment: { id: 10, body: "/agent review", user: { login: "example-owner" } },
    })
    const request = signedRequest("issue_comment", commandPayload, `command-${status}`, secret)
    const layer = dispositionLayer(
      {
        ingestCommand: () =>
          Effect.sync(() => {
            actions.push(`commit:${status}`)
            return { status }
          }),
      },
      actions,
    )

    const response = await Effect.runPromise(
      handleGitHubWebhook(request, {
        webhookSecret: secret,
        now: new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(Effect.provide(layer)),
    )

    expect(response.status).toBe(202)
    expect(actions).toEqual(lane === undefined ? [`commit:${status}`] : [`commit:${status}`, lane])
  })
})

function signedRequest(event: string, body: string, deliveryId: string, secret: string) {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  return new Request("http://localhost/hooks/github", {
    method: "POST",
    body,
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
  })
}

function dispositionLayer(store: Partial<WorkflowStorePort>, actions: Array<string>) {
  const signals: WorkSignalPort = {
    subscribe: () => Effect.die("unused"),
    wake: (lane) => Effect.sync(() => actions.push(lane)),
  }
  const StoreWithDisposition = Layer.effect(
    WorkflowStore,
    Effect.map(WorkflowStore, (live) => ({ ...live, ...store })),
  ).pipe(Layer.provide(WorkflowStoreLive.pipe(Layer.provide(DatabaseLive))))
  return Layer.merge(StoreWithDisposition, Layer.succeed(WorkSignal, signals))
}

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

  test("authenticates and decodes QRSPI kickoff before invoking the trusted handler", async () => {
    let calls = 0
    const start = (input: unknown) => {
      calls += 1
      return Effect.succeed({ received: input })
    }
    const body = {
      repository: {
        providerInstanceId: "github-app-123",
        repositoryId: "42",
        repositoryFullName: "example-owner/example",
      },
      ticket: {
        tracker: "beads",
        trackerInstanceId: "workspace-42",
        nativeTicketId: "workflowd-vs3.3",
      },
    }
    const unauthorized = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/qrspi", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { authorization: "Bearer wrong" },
        }),
        {
          webhookSecret: "secret",
          now: new Date("2026-07-19T12:00:00.000Z"),
          qrspi: { token: "kickoff-secret", start },
        },
      ).pipe(Effect.provide(TestLayer)),
    )
    const authorized = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/qrspi", {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            authorization: "Bearer kickoff-secret",
            "content-type": "application/json",
          },
        }),
        {
          webhookSecret: "secret",
          now: new Date("2026-07-19T12:00:00.000Z"),
          qrspi: { token: "kickoff-secret", start },
        },
      ).pipe(Effect.provide(TestLayer)),
    )

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(202)
    expect(calls).toBe(1)
    expect(await authorized.json()).toEqual({ received: body })
  })

  test("returns 503 for QRSPI ticket-source infrastructure failure", async () => {
    const response = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/qrspi", {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer kickoff-secret" },
        }),
        {
          webhookSecret: "secret",
          now: new Date("2026-07-19T12:00:00.000Z"),
          qrspi: {
            token: "kickoff-secret",
            start: () => Effect.fail(new TicketSourceError({ cause: new Error("bd unavailable") })),
          },
        },
      ).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(503)
  })

  test("returns 500 for corrupt durable QRSPI state", async () => {
    const response = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/qrspi", {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer kickoff-secret" },
        }),
        {
          webhookSecret: "secret",
          now: new Date("2026-07-19T12:00:00.000Z"),
          qrspi: {
            token: "kickoff-secret",
            start: () =>
              Effect.fail(
                new QrspiStoreDataError({
                  record: "workflow_operation",
                  recordId: "corrupt",
                  message: "invalid input",
                }),
              ),
          },
        },
      ).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(500)
  })

  test.each([
    ["unknown_contract_reference", "contract"],
    ["unavailable_agent_model", "availability"],
    ["hash_mismatch", "persisted"],
  ] as const)(
    "returns a bounded 503 response for closed QRSPI reason %s",
    async (reason, phase) => {
      const response = await Effect.runPromise(
        routeRequest(
          new Request("http://localhost/workflows/qrspi", {
            method: "POST",
            body: "{}",
            headers: { authorization: "Bearer kickoff-secret" },
          }),
          {
            webhookSecret: "secret",
            now: new Date("2026-07-19T12:00:00.000Z"),
            qrspi: {
              token: "kickoff-secret",
              start: () =>
                Effect.fail(
                  new WorkflowStartValidationError({
                    phase,
                    reason,
                    cause: "must not cross the HTTP boundary",
                  }),
                ),
            },
          },
        ).pipe(Effect.provide(TestLayer)),
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "WorkflowStartValidationError" })
    },
  )
})
