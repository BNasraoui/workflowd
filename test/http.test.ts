import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlError } from "effect/unstable/sql"
import { Effect, Layer, Logger, Queue } from "effect"
import { AgentHarnessError } from "../src/agent-harness"
import { handleGitHubWebhook, routeRequest } from "../src/http"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore, type WorkflowStorePort } from "../src/store/contracts"
import { WorkSignal, WorkSignalLive, type WorkSignalPort } from "../src/work-signal"
import { WorkflowDefinitionValidationError } from "../src/qrspi/domain"
import { QrspiRepositoryError, TicketSourceError } from "../src/qrspi/ports"
import { StageCatalogError } from "../src/qrspi/stage-catalog"
import { QrspiStoreDataError } from "../src/qrspi/store"
import {
  TicketReadError,
  WorkflowStartBusy,
  WorkflowStartConflict,
  WorkflowStartNeedsOperator,
  WorkflowStartRetryExhausted,
  WorkflowStartSuperseded,
  WorkflowStartUnauthorized,
  WorkflowStartUncertain,
  WorkflowStartValidationError,
  type WorkflowStartError,
} from "../src/qrspi/workflow-start"
import { TestJobCanaryConflict, TestJobCanaryNotFound } from "../src/kernel/test-job-canary"

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
      logs.push({ level: logLevel, message })
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
      }).pipe(Effect.provide(TestLayer), Effect.provide(Logger.layer([logger]))),
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
          if (first === null) return yield* Effect.die(new Error("expected reconciliation"))
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

  test("keeps test-job routes absent when the canary is disabled", async () => {
    const responses = await Promise.all(
      [
        new Request("http://localhost/workflows/test-jobs", { method: "POST", body: "{}" }),
        new Request("http://localhost/workflows/test-jobs/job-1"),
      ].map((request) =>
        Effect.runPromise(
          routeRequest(request, {
            webhookSecret: "secret",
            now: new Date("2026-07-19T12:00:00.000Z"),
          }).pipe(Effect.provide(TestLayer)),
        ),
      ),
    )

    expect(responses.map((response) => response.status)).toEqual([404, 404])
  })

  test("authenticates and strictly decodes bounded test-job submissions", async () => {
    const calls: Array<unknown> = []
    const canary = {
      token: "test-job-secret",
      submit: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input)
          return { jobId: "job-1", status: "pending" as const, newlyEnqueued: true }
        }),
      status: () => Effect.die("unused"),
    }
    const request = (body: string, authorization = "Bearer test-job-secret") =>
      routeRequest(
        new Request("http://localhost/workflows/test-jobs", {
          method: "POST",
          body,
          headers: { authorization },
        }),
        {
          webhookSecret: "secret",
          now: new Date("2026-07-19T12:00:00.000Z"),
          maxBodyBytes: 50,
          testJobs: canary,
        },
      ).pipe(Effect.provide(TestLayer), Effect.runPromise)

    const unauthorized = await request('{"jobId":"job-1","value":null}', "Bearer wrong")
    const malformed = await request("{")
    const extra = await request('{"jobId":"job-1","value":null,"extra":true}')
    const invalidId = await request('{"jobId":"","value":null}')
    const dotId = await request('{"jobId":".","value":null}')
    const dotDotId = await request('{"jobId":"..","value":null}')
    const oversized = await request(JSON.stringify({ jobId: "job-1", value: "x".repeat(100) }))
    const accepted = await request('{"jobId":"job-1","value":{"probe":true}}')

    expect([
      unauthorized.status,
      malformed.status,
      extra.status,
      invalidId.status,
      dotId.status,
      dotDotId.status,
      oversized.status,
    ]).toEqual([401, 400, 400, 400, 400, 400, 413])
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ jobId: "job-1", status: "pending" })
    expect(calls).toEqual([{ jobId: "job-1", value: { probe: true } }])
  })

  test("returns canary conflicts and lifecycle status without premature results", async () => {
    const testJobs = {
      token: "test-job-secret",
      submit: () => Effect.fail(new TestJobCanaryConflict({ jobId: "job-1" })),
      status: (jobId: string) =>
        jobId === "missing"
          ? Effect.fail(new TestJobCanaryNotFound({ jobId }))
          : Effect.succeed({ jobId, status: "running" as const }),
    }
    const options = {
      webhookSecret: "secret",
      now: new Date("2026-07-19T12:00:00.000Z"),
      testJobs,
    }
    const auth = { authorization: "Bearer test-job-secret" }
    const conflict = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/test-jobs", {
          method: "POST",
          body: '{"jobId":"job-1","value":false}',
          headers: auth,
        }),
        options,
      ).pipe(Effect.provide(TestLayer)),
    )
    const known = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/test-jobs/job-1", { headers: auth }),
        options,
      ).pipe(Effect.provide(TestLayer)),
    )
    const unknown = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/test-jobs/missing", { headers: auth }),
        options,
      ).pipe(Effect.provide(TestLayer)),
    )

    expect(conflict.status).toBe(409)
    expect(await known.json()).toEqual({ jobId: "job-1", status: "running" })
    expect(unknown.status).toBe(404)
  })

  test("rejects malformed encoded test-job IDs without invoking status", async () => {
    let calls = 0
    const response = await Effect.runPromise(
      routeRequest(
        new Request("http://localhost/workflows/test-jobs/%E0%A4%A", {
          headers: { authorization: "Bearer test-job-secret" },
        }),
        {
          webhookSecret: "secret",
          now: new Date("2026-07-19T12:00:00.000Z"),
          testJobs: {
            token: "test-job-secret",
            submit: () => Effect.die("unused"),
            status: () => {
              calls += 1
              return Effect.die("must not run")
            },
          },
        },
      ).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(400)
    expect(calls).toBe(0)
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

describe("QRSPI ingress status mapping", () => {
  const failures: ReadonlyArray<readonly [WorkflowStartError, number]> = [
    [new WorkflowStartUnauthorized({ reason: "Repository is not authorized" }), 400],
    [new TicketReadError({ reason: "Beads ticket could not be decoded" }), 400],
    [new WorkflowStartConflict({ reason: "Target reconciliation is still active" }), 409],
    [new WorkflowStartSuperseded({ reason: "Authoritative input changed" }), 409],
    [new WorkflowStartBusy({ reason: "WorkflowStart is leased by another caller" }), 409],
    [new WorkflowStartUncertain({ reason: "Repository outcome is unknown" }), 409],
    [new WorkflowStartNeedsOperator({ reason: "WorkflowStart requires an operator" }), 409],
    [new WorkflowStartRetryExhausted({ reason: "Retry budget exhausted" }), 409],
    [new TicketSourceError({ cause: new Error("bd unavailable") }), 503],
    [new QrspiRepositoryError({ operation: "inspect", cause: new Error("api down") }), 503],
    [new StageCatalogError({ reason: "unknown_reference", reference: "research@1" }), 503],
    [
      new AgentHarnessError({
        operation: "describe",
        cause: new Error("model unavailable"),
        retryable: true,
      }),
      503,
    ],
    [new WorkflowDefinitionValidationError({ phase: "pure", reason: "no_runnable_stage" }), 503],
    [
      new WorkflowStartValidationError({ phase: "contract", reason: "unknown_contract_reference" }),
      503,
    ],
    // TODO(effect-v4): SqlError family
    [
      new SqlError.SqlError({
        reason: new SqlError.ConnectionError({ cause: new Error("database is locked") }),
      }),
      503,
    ],
    [
      new QrspiStoreDataError({
        record: "workflow_definition",
        recordId: "definition-1",
        message: "row is not decodable",
      }),
      500,
    ],
  ]

  test.each(failures)("answers %s with its ingress status", async (error, status) => {
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
          qrspi: { token: "kickoff-secret", start: () => Effect.fail(error) },
        },
      ).pipe(Effect.provide(TestLayer)),
    )

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: error._tag })
  })
})
