import { readFile } from "node:fs/promises"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Context, Effect, Layer } from "effect"
import { connect } from "@nats-io/transport-node"
import {
  jetstream,
  jetstreamManager,
  StorageType,
  RetentionPolicy,
  DiscardPolicy,
  JetStreamApiError,
  JetStreamApiCodes,
} from "@nats-io/jetstream"
import type { AppConfig } from "../config"
import { natsAuthOptions } from "../remote/auth"
import type { CiConfig } from "./config"
import type { CiRequest } from "./reconcile"
export const CiProvider = Context.Service<{
  readonly request: (installationId: number) => Effect.Effect<CiRequest, Error>
  readonly publish: (subject: string, body: string, id: string) => Effect.Effect<void, Error>
}>("workflowd/CiProvider")
const STREAM = "WORKFLOWD_CI_V1"
export const CiProviderLive = (
  config: CiConfig,
  github: AppConfig["github"],
  OctokitClass: typeof Octokit = Octokit,
) =>
  Layer.effect(
    CiProvider,
    Effect.gen(function* () {
      const key = yield* Effect.tryPromise(() => readFile(github.privateKeyPath, "utf8"))
      const app = new App({ appId: github.appId, privateKey: key, Octokit: OctokitClass })
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
        const expected = {
          name: STREAM,
          subjects: ["workflowd.v1.ci.>"],
          storage: StorageType.File,
          retention: RetentionPolicy.Limits,
          discard: DiscardPolicy.Old,
          max_age: 86400 * 1e9,
          max_bytes: 64 * 1024 * 1024,
        }
        const info = await manager.streams.info(STREAM).catch((error: unknown) => {
          if (error instanceof JetStreamApiError && error.code === JetStreamApiCodes.StreamNotFound)
            return undefined
          throw error
        })
        if (info === undefined) {
          await manager.streams.add(expected)
          return
        }
        const mismatches = (Object.keys(expected) as Array<keyof typeof expected>).filter(
          (key) => JSON.stringify(info.config[key]) !== JSON.stringify(expected[key]),
        )
        if (mismatches.length > 0)
          throw new Error(
            `Incompatible CI stream ${STREAM}: ${mismatches.join(", ")}; refusing to reconfigure existing stream`,
          )
      })
      return {
        request: (installationId: number) =>
          Effect.gen(function* () {
            const client = yield* Effect.tryPromise(() =>
              app.getInstallationOctokit(installationId),
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
            return request
          }).pipe(Effect.mapError(() => new Error("CI installation client unavailable"))),
        publish: (subject: string, body: string, id: string) =>
          Effect.tryPromise({
            try: () => jetstream(connection).publish(subject, body, { msgID: id }),
            catch: () => new Error("CI publication unavailable"),
          }).pipe(Effect.asVoid),
      }
    }),
  )
