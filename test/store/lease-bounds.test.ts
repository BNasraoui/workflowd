import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { WorkflowStore, type WorkflowStorePort } from "../../src/store/contracts"
import type { LeaseClaim, RescheduleJobInput } from "../../src/store/model"
import {
  changesRequestedReview,
  decodePullRequestEvent,
  makeStoreLayer,
  sampleCommandEvent,
  samplePullRequestEvent,
} from "./harness"

const pullRequestDelivery = {
  deliveryId: "lease-pr",
  event: "pull_request",
  action: "opened",
  payload: "{}",
  receivedAt: new Date("2026-07-19T12:00:00.000Z"),
} as const

const arrangeJob = (store: WorkflowStorePort) =>
  store.ingestPullRequest(pullRequestDelivery, samplePullRequestEvent)

const arrangePublication = (store: WorkflowStorePort) =>
  Effect.gen(function* () {
    yield* arrangeJob(store)
    const review = yield* store.claimNextJob({
      workerId: "lease-reviewer",
      now: new Date("2026-07-19T12:01:00.000Z"),
      leaseDurationMs: 60_000,
    })
    if (review === null) throw new Error("expected review")
    yield* store.completeReviewJob({
      jobId: review.id,
      workerId: "lease-reviewer",
      completedAt: new Date("2026-07-19T12:01:59.999Z"),
      review: changesRequestedReview,
      autoFix: false,
    })
  })

const arrangeCommand = (store: WorkflowStorePort) =>
  store.ingestCommand(
    {
      deliveryId: "lease-command",
      event: "issue_comment",
      action: "created",
      payload: "{}",
      receivedAt: new Date("2026-07-19T12:00:00.000Z"),
    },
    sampleCommandEvent("status", 7001),
  )

const arrangeReconciliation = (store: WorkflowStorePort) =>
  Effect.gen(function* () {
    const updatedAt = "2026-07-19T12:00:00.000Z"
    yield* store.ingestPullRequest(pullRequestDelivery, {
      ...samplePullRequestEvent,
      pullRequest: { ...samplePullRequestEvent.pullRequest, updatedAt },
    })
    yield* store.ingestPullRequest(
      {
        ...pullRequestDelivery,
        deliveryId: "lease-reconciliation",
        action: "synchronize",
        receivedAt: new Date("2026-07-19T12:00:01.000Z"),
      },
      decodePullRequestEvent({
        ...samplePullRequestEvent,
        action: "synchronize",
        pullRequest: {
          ...samplePullRequestEvent.pullRequest,
          headSha: "e".repeat(40),
          updatedAt,
        },
      }),
    )
  })

const leaseCases = [
  {
    label: "job",
    table: "jobs",
    maxAttempts: 3,
    arrange: arrangeJob,
    claim: (store: WorkflowStorePort, input: LeaseClaim) =>
      store
        .claimNextJob(input)
        .pipe(
          Effect.map((work) => (work === null ? null : { id: work.id, attempts: work.attempt })),
        ),
    reschedule: (store: WorkflowStorePort, id: number, input: Omit<RescheduleJobInput, "jobId">) =>
      store.rescheduleJob({ ...input, jobId: id }),
  },
  {
    label: "publication",
    table: "publications",
    maxAttempts: 5,
    arrange: arrangePublication,
    claim: (store: WorkflowStorePort, input: LeaseClaim) =>
      store
        .claimNextPublication(input)
        .pipe(
          Effect.map((publication) =>
            publication === null ? null : { id: publication.id, attempts: publication.attempt },
          ),
        ),
    reschedule: (store: WorkflowStorePort, id: number, input: Omit<RescheduleJobInput, "jobId">) =>
      store.reschedulePublication({ ...input, publicationId: id }),
  },
  {
    label: "command",
    table: "commands",
    maxAttempts: 3,
    arrange: arrangeCommand,
    claim: (store: WorkflowStorePort, input: LeaseClaim) => store.claimNextCommand(input),
    reschedule: (store: WorkflowStorePort, id: number, input: Omit<RescheduleJobInput, "jobId">) =>
      store.rescheduleCommand({ ...input, commandId: id }),
  },
  {
    label: "reconciliation",
    table: "reconciliations",
    maxAttempts: 5,
    arrange: arrangeReconciliation,
    claim: (store: WorkflowStorePort, input: LeaseClaim) => store.claimNextReconciliation(input),
    reschedule: (store: WorkflowStorePort, id: number, input: Omit<RescheduleJobInput, "jobId">) =>
      store.rescheduleReconciliation({ ...input, reconciliationId: id }),
  },
] as const

describe("durable lease queues", () => {
  for (const leaseCase of leaseCases) {
    test(`${leaseCase.label} recovers at exact expiry and exhausts attempts`, async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* WorkflowStore
          const sql = yield* SqlClient.SqlClient
          yield* leaseCase.arrange(store)

          const attempts = []
          const startedAt = Date.parse("2026-07-19T13:00:00.000Z")
          for (let attempt = 0; attempt <= leaseCase.maxAttempts; attempt += 1) {
            attempts.push(
              yield* leaseCase.claim(store, {
                workerId: `${leaseCase.label}-lost-${attempt}`,
                now: new Date(startedAt + attempt * 1_000),
                leaseDurationMs: 1_000,
              }),
            )
          }
          const rows = yield* sql.unsafe<{
            readonly attempts: number
            readonly state: string
          }>(`SELECT attempts, state FROM ${leaseCase.table}`)
          return { attempts, row: rows[0] }
        }).pipe(Effect.provide(makeStoreLayer())),
      )

      expect(result.attempts.slice(0, leaseCase.maxAttempts).map((item) => item?.attempts)).toEqual(
        Array.from({ length: leaseCase.maxAttempts }, (_, index) => index + 1),
      )
      expect(result.attempts[leaseCase.maxAttempts]).toBeNull()
      expect(result.row).toEqual({
        attempts: leaseCase.maxAttempts,
        state: "failed",
      })
    })

    test(`${leaseCase.label} honors retry time and rejects stale reschedules`, async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* WorkflowStore
          yield* leaseCase.arrange(store)
          const claimed = yield* leaseCase.claim(store, {
            workerId: `${leaseCase.label}-worker`,
            now: new Date("2026-07-19T13:00:00.000Z"),
            leaseDurationMs: 60_000,
          })
          if (claimed === null) throw new Error(`expected ${leaseCase.label}`)

          const disposition = yield* leaseCase.reschedule(store, claimed.id, {
            workerId: `${leaseCase.label}-worker`,
            failedAt: new Date("2026-07-19T13:00:01.000Z"),
            runAt: new Date("2026-07-19T13:10:00.000Z"),
            error: "temporary failure",
            maxAttempts: leaseCase.maxAttempts,
          })
          const stale = yield* leaseCase.reschedule(store, claimed.id, {
            workerId: `${leaseCase.label}-worker`,
            failedAt: new Date("2026-07-19T13:00:02.000Z"),
            runAt: new Date("2026-07-19T13:10:00.000Z"),
            error: "duplicate failure",
            maxAttempts: leaseCase.maxAttempts,
          })
          const early = yield* leaseCase.claim(store, {
            workerId: `${leaseCase.label}-retry-worker`,
            now: new Date("2026-07-19T13:09:59.999Z"),
            leaseDurationMs: 60_000,
          })
          const retried = yield* leaseCase.claim(store, {
            workerId: `${leaseCase.label}-retry-worker`,
            now: new Date("2026-07-19T13:10:00.000Z"),
            leaseDurationMs: 60_000,
          })
          return { disposition, early, retried, stale }
        }).pipe(Effect.provide(makeStoreLayer())),
      )

      expect(result.disposition).toBe("retry")
      expect(result.stale).toBe("stale")
      expect(result.early).toBeNull()
      expect(result.retried?.attempts).toBe(2)
    })

    test(`${leaseCase.label} rejects rescheduling at exact lease expiry`, async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* WorkflowStore
          const sql = yield* SqlClient.SqlClient
          yield* leaseCase.arrange(store)
          const claimed = yield* leaseCase.claim(store, {
            workerId: `${leaseCase.label}-expired-worker`,
            now: new Date("2026-07-19T13:00:00.000Z"),
            leaseDurationMs: 1_000,
          })
          if (claimed === null) throw new Error(`expected ${leaseCase.label}`)

          const disposition = yield* leaseCase.reschedule(store, claimed.id, {
            workerId: `${leaseCase.label}-expired-worker`,
            failedAt: new Date("2026-07-19T13:00:01.000Z"),
            runAt: new Date("2026-07-19T13:10:00.000Z"),
            error: "late failure",
            maxAttempts: leaseCase.maxAttempts,
          })
          const rows = yield* sql.unsafe<{
            readonly lease_owner: string | null
            readonly state: string
          }>(`SELECT state, lease_owner FROM ${leaseCase.table} WHERE id = ?`, [claimed.id])
          return { disposition, row: rows[0] }
        }).pipe(Effect.provide(makeStoreLayer())),
      )

      expect(result.disposition).toBe("stale")
      expect(result.row).toEqual({
        state: "leased",
        lease_owner: `${leaseCase.label}-expired-worker`,
      })
    })
  }
})
