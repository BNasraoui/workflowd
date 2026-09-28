import { readFile } from "node:fs/promises"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Context, Effect, Layer, Schedule } from "effect"
import { connect } from "@nats-io/transport-node"
import {
  jetstream,
  jetstreamManager,
  StorageType,
  RetentionPolicy,
  DiscardPolicy,
} from "@nats-io/jetstream"
import type { AppConfig } from "../config"
import { natsAuthOptions } from "../remote/auth"
import type { CiConfig } from "./config"
import { makeCiStore, type CiStore } from "./store"
import { reconcileCi, type CiRequest } from "./reconcile"

export const CiService = Context.Service<CiStore>("workflowd/CiService")
const STREAM = "WORKFLOWD_CI_V1"

export const CiServiceLive = (config: CiConfig, github: AppConfig["github"]) =>
  Layer.effect(
    CiService,
    Effect.gen(function* () {
      const store = yield* makeCiStore
      const key = yield* Effect.tryPromise(() => readFile(github.privateKeyPath, "utf8"))
      const app = new App({ appId: github.appId, privateKey: key, Octokit })
      // This connection is owned by the layer, never by a waiting HTTP request.
      const connection = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          connect({
            servers: [...config.servers],
            ...natsAuthOptions(config.auth),
            maxReconnectAttempts: -1,
          }),
        ),
        (connection) => Effect.tryPromise(() => connection.drain()).pipe(Effect.ignore),
      )
      const manager = yield* Effect.tryPromise(() => jetstreamManager(connection))
      yield* Effect.tryPromise(async () => {
        const exists = await manager.streams.find("workflowd.v1.ci.>").catch(() => undefined)
        if (exists === undefined)
          await manager.streams.add({
            name: STREAM,
            subjects: ["workflowd.v1.ci.>"],
            storage: StorageType.File,
            retention: RetentionPolicy.Limits,
            discard: DiscardPolicy.Old,
            max_age: 86400 * 1e9,
            max_bytes: 64 * 1024 * 1024,
          })
        const info = await manager.streams.info(STREAM)
        if (
          info.config.storage !== StorageType.File ||
          info.config.retention !== RetentionPolicy.Limits ||
          info.config.subjects.join() !== "workflowd.v1.ci.>"
        )
          throw new Error("Incompatible CI stream")
      })
      const publish = Effect.gen(function* () {
        for (const delivery of yield* store.deliveryOutbox()) {
          const { event, deliveryId } = delivery
          const subject = `workflowd.v1.ci.${Buffer.from(event.repository).toString("hex")}.${event.sha}.completed`
          yield* Effect.tryPromise(() =>
            jetstream(connection).publish(subject, JSON.stringify(delivery), {
              msgID: `ci-delivery:${deliveryId}`,
            }),
          )
          yield* store.deliveryPublished(deliveryId)
        }
        for (const state of yield* store.outbox()) {
          const subject = `workflowd.v1.ci.${Buffer.from(state.repository).toString("hex")}.${state.sha}`
          yield* Effect.tryPromise(() =>
            jetstream(connection).publish(subject, JSON.stringify(state), {
              msgID: `ci:${state.sequence}`,
            }),
          )
          yield* store.published(state.sequence)
        }
      })
      const reconcile = Effect.gen(function* () {
        const now = Date.now()
        for (const row of yield* store.due(now)) {
          const repository = config.repositories.find(
            (r) => r.repository === row.repository && r.installationId === row.installation_id,
          )
          if (repository === undefined) {
            yield* store.defer(row, now + 86400000)
            continue
          }
          // Back off before network I/O so every failure, including rate limiting,
          // shares one global budget rather than immediately retrying per waiter.
          yield* store.defer(row, now + 300000)
          const client = yield* Effect.tryPromise(() =>
            app.getInstallationOctokit(row.installation_id),
          )
          const request: CiRequest = async (path, etag) => {
            try {
              const response = await client.request(`GET ${path}`, {
                headers: etag === null ? {} : { "if-none-match": etag },
                request: { timeout: 10000 },
              })
              return {
                status: response.status,
                etag: response.headers.etag ?? null,
                data: response.data,
              }
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "status" in error &&
                error.status === 304
              )
                return { status: 304, etag, data: null }
              // SDK errors can contain authorization headers. Never retain them.
              // eslint-disable-next-line preserve-caught-error -- SDK causes may include credential headers.
              throw new Error("CI GitHub request failed; check App permissions and rate limits")
            }
          }
          const snapshot = yield* reconcileCi(request, row, row.etag)
          if (snapshot.status === "snapshot")
            yield* store.snapshot(row, snapshot.runs, snapshot.etag, now)
          else yield* store.defer(row, now + 60000)
        }
      })
      const supervise = <E>(name: string, iteration: Effect.Effect<void, E>, interval: number) =>
        iteration.pipe(
          Effect.catch(() => Effect.logWarning(`CI ${name} failed; retained for retry`)),
          Effect.repeat(Schedule.spaced(interval)),
          Effect.forkScoped,
        )
      yield* supervise("publication", publish, 1000)
      yield* supervise("reconciliation", reconcile, 60000)
      return store
    }),
  )
