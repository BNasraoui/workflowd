import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ExecutionDiscovery } from "../execution-capabilities"
import { RemoteTransport, type RemoteTransportError } from "../remote/transport"
import { DirectoryStore } from "./store"
import { DirectoryError, runnerIdForHost } from "./contract"
import type { DirectoryRunnerConfig } from "./config"
import { MAX_REMOTE_MESSAGE_BYTES } from "../remote/contract"
import {
  DirectoryObserve,
  DirectoryPage,
  authenticDirectoryMessage,
  decodeDirectoryMessage,
  directoryBytes,
  directoryMac,
} from "./wire"

export const DirectoryResponder = Context.Service<{
  readonly handle: (
    bytes: Uint8Array,
  ) => Effect.Effect<boolean, DirectoryError | RemoteTransportError>
}>("workflowd/DirectoryResponder")

export const DirectoryResponderLive = (hostId: string, config: DirectoryRunnerConfig) =>
  Layer.effect(
    DirectoryResponder,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* DirectoryStore
      const discovery = yield* ExecutionDiscovery
      const transport = yield* RemoteTransport
      yield* store.bindLocalHost(hostId)
      const respond = Effect.fn("DirectoryResponder.respond")(
        function* (command: DirectoryObserve) {
          const rows =
            yield* sql`SELECT generation,request_json,response_json FROM directory_runner_responses WHERE coordinator_host_id = ${command.coordinatorHostId}`
          const previous = rows[0]
          if (
            previous !== undefined &&
            typeof previous.generation === "number" &&
            previous.generation > command.generation
          )
            return []
          if (previous !== undefined && previous.generation === command.generation) {
            if (previous.request_json !== JSON.stringify(command))
              return yield* Effect.fail(new DirectoryError({ reason: "stale_binding" }))
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(DirectoryPage)),
            )(previous.response_json)
          }
          const leaseMs = Math.min(
            90_000,
            Date.parse(command.expiresAt) - Date.parse(command.issuedAt),
          )
          const catalog = yield* discovery.list()
          const at = new Date()
          const snapshot = {
            agents: [...(yield* store.managed(at, leaseMs)), ...(yield* store.external(at))],
            runners: [
              {
                runnerId: runnerIdForHost(hostId),
                hostId,
                status: "active" as const,
                observedAt: at.toISOString(),
                expiresAt: new Date(at.getTime() + leaseMs).toISOString(),
                catalog,
              },
            ],
          }
          const content = JSON.stringify({ snapshot, registrations: yield* store.registrations() })
          // Keep JSON escaping and UTF-8 expansion inside the existing stream budget.
          const chunks: string[] = []
          for (let offset = 0; offset < content.length; offset += 2048)
            chunks.push(content.slice(offset, offset + 2048))
          if (chunks.length > 128)
            return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
          const pages = chunks.map((content, page) => {
            const document = {
              version: 1 as const,
              kind: "directory_page" as const,
              hostId,
              coordinatorHostId: command.coordinatorHostId,
              generation: command.generation,
              nonce: command.nonce,
              page,
              total: chunks.length,
              content,
            }
            return { ...document, signature: directoryMac(config.credential, document) }
          })
          if (pages.some((page) => directoryBytes(page).byteLength > MAX_REMOTE_MESSAGE_BYTES))
            return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
          yield* sql`INSERT INTO directory_runner_responses(coordinator_host_id,generation,request_json,response_json) VALUES(${command.coordinatorHostId},${command.generation},${JSON.stringify(command)},${JSON.stringify(pages)})
      ON CONFLICT(coordinator_host_id) DO UPDATE SET generation = excluded.generation, request_json = excluded.request_json, response_json = excluded.response_json
      WHERE directory_runner_responses.generation < excluded.generation`
          const currentRows =
            yield* sql`SELECT generation,request_json,response_json FROM directory_runner_responses WHERE coordinator_host_id = ${command.coordinatorHostId}`
          const current = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              generation: Schema.Int,
              request_json: Schema.String,
              response_json: Schema.String,
            }),
          )(currentRows[0])
          if (current.generation > command.generation) return []
          if (current.request_json !== JSON.stringify(command))
            return yield* Effect.fail(new DirectoryError({ reason: "stale_binding" }))
          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Array(DirectoryPage)),
          )(current.response_json)
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((error) =>
              error instanceof DirectoryError
                ? error
                : new DirectoryError({ reason: "unavailable" }),
            ),
          ),
      )
      return DirectoryResponder.of({
        handle: Effect.fn("DirectoryResponder.handle")(function* (bytes) {
          const decoded = yield* decodeDirectoryMessage(DirectoryObserve, bytes).pipe(Effect.result)
          if (decoded._tag === "Failure") return false
          const command = decoded.success
          const now = Date.now()
          if (
            command.hostId !== hostId ||
            command.coordinatorHostId !== config.coordinatorHostId ||
            !authenticDirectoryMessage(config.credential, command) ||
            Date.parse(command.issuedAt) > now ||
            Date.parse(command.expiresAt) <= now ||
            Date.parse(command.expiresAt) - Date.parse(command.issuedAt) > 35_000
          )
            return true
          const pages = yield* respond(command)
          for (const page of pages)
            yield* transport.publishRaw(
              `workflowd.v1.commands.directory-${command.coordinatorHostId}`,
              directoryBytes(page),
            )
          return true
        }),
      })
    }),
  )
