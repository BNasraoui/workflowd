import { Context, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AppConfig } from "../config"
import type { CiConfig } from "./config"
import { makeCiStore, type CiStore } from "./store"
import { reconcileCi } from "./reconcile"
import { CiProvider, CiProviderLive } from "./provider"
export const CiService = Context.Service<CiStore>("workflowd/CiService")
export const makeCiWorkers = (repositories: CiConfig["repositories"]) =>
  Effect.gen(function* () {
    const store = yield* makeCiStore
    const sql = yield* SqlClient.SqlClient
    const provider = yield* CiProvider
    const ingest: CiStore["ingest"] = (deliveryId, event, payload, now) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const policy = repositories.find(
            (r) => r.repository === event.repository && r.installationId === event.installationId,
          )
          if (policy !== undefined)
            yield* store.watch(event, policy.installationId, policy.workflows, now)
          return yield* store.ingest(deliveryId, event, payload, now)
        }),
      )
    const publish = Effect.gen(function* () {
      for (const delivery of yield* store.deliveryOutbox()) {
        const { event, deliveryId } = delivery
        const subject = `workflowd.v1.ci.${Buffer.from(event.repository).toString("hex")}.${event.sha}.completed`
        yield* provider.publish(subject, JSON.stringify(delivery), `ci-delivery:${deliveryId}`)
        yield* store.deliveryPublished(deliveryId)
      }
      for (const state of yield* store.outbox()) {
        const subject = `workflowd.v1.ci.${Buffer.from(state.repository).toString("hex")}.${state.sha}`
        yield* provider.publish(subject, JSON.stringify(state), `ci:${state.sequence}`)
        yield* store.published(state.sequence)
      }
    })
    const reconcile = Effect.gen(function* () {
      const now = Date.now()
      for (const row of yield* store.due(now)) {
        const repository = repositories.find(
          (r) => r.repository === row.repository && r.installationId === row.installation_id,
        )
        if (repository === undefined) {
          yield* store.defer(row, now + 86400000)
          continue
        }
        // Back off before network I/O so every failure, including rate limiting,
        // shares one global budget rather than immediately retrying per waiter.
        yield* store.defer(row, now + 300000)
        const request = yield* provider.request(row.installation_id)
        const snapshot = yield* reconcileCi(request, row, row.etag)
        if (snapshot.status === "snapshot")
          yield* store.snapshot(row, snapshot.runs, snapshot.etag, now)
        else yield* store.defer(row, now + 60000)
      }
    })
    return { port: { ...store, ingest }, publish, reconcile }
  })
export const CiServiceLive = (config: CiConfig, github: AppConfig["github"]) =>
  Layer.effect(
    CiService,
    Effect.gen(function* () {
      const { port, publish, reconcile } = yield* makeCiWorkers(config.repositories)
      const supervise = <E>(name: string, iteration: Effect.Effect<void, E>, interval: number) =>
        iteration.pipe(
          Effect.catch(() => Effect.logWarning(`CI ${name} failed; retained for retry`)),
          Effect.repeat(Schedule.spaced(interval)),
          Effect.forkScoped,
        )
      yield* supervise("publication", publish, 1000)
      yield* supervise("reconciliation", reconcile, 60000)
      return port
    }),
  ).pipe(Layer.provide(CiProviderLive(config, github)))
