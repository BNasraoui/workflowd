import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DirectoryError, DirectorySnapshot, runnerIdForHost } from "./contract"
import { DirectoryAdvertisement, DirectoryObserve, type DirectoryPage, directoryMac } from "./wire"
import type { DirectoryPeer } from "./config"
import { externalRecipientId, verifyRegistration } from "./proof"
import { canonicalJson } from "../kernel/session-store-support"
import { claimExternalOwner } from "./ownership"
import type { ExecutionCapabilities } from "../execution-capability-contract"

const validCatalogClock = (catalog: ExecutionCapabilities, at: Date) => {
  const observed = (timestamp: string) =>
    Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) <= at.getTime() + 5000
  return (
    catalog.capabilities.every((capability) => observed(capability.observedAt)) &&
    catalog.sources.every(
      (source) =>
        observed(source.checkedAt) &&
        (source.observedAt === null || observed(source.observedAt)) &&
        (source.freshUntil === null || Number.isFinite(Date.parse(source.freshUntil))),
    )
  )
}

export const DirectoryRemoteStore = Context.Service<{
  readonly prepare: (
    peer: DirectoryPeer,
    coordinatorHostId: string,
    at: Date,
    refreshMs: number,
    leaseMs: number,
  ) => Effect.Effect<DirectoryObserve | null, DirectoryError>
  readonly accept: (
    page: DirectoryPage,
    at: Date,
    leaseMs: number,
  ) => Effect.Effect<"accepted" | "partial" | "duplicate" | "stale", DirectoryError>
  readonly inventory: (
    hosts: ReadonlyArray<string>,
    at: Date,
  ) => Effect.Effect<DirectorySnapshot, DirectoryError>
}>("workflowd/DirectoryRemoteStore")

const persistedError = (error: unknown) =>
  error instanceof DirectoryError ? error : new DirectoryError({ reason: "unavailable" })

export const DirectoryRemoteStoreLive = Layer.effect(
  DirectoryRemoteStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const prepare = Effect.fn("DirectoryRemoteStore.prepare")(
      function* (
        peer: DirectoryPeer,
        coordinatorHostId: string,
        at: Date,
        refreshMs: number,
        leaseMs: number,
      ) {
        yield* sql`INSERT INTO directory_peer_observations(host_id) VALUES(${peer.hostId}) ON CONFLICT DO NOTHING`
        const rows =
          yield* sql`SELECT generation,request_json,completed FROM directory_peer_observations WHERE host_id = ${peer.hostId}`
        const row = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            generation: Schema.Int,
            request_json: Schema.NullOr(Schema.String),
            completed: Schema.Int,
          }),
        )(rows[0])
        if (row.request_json !== null) {
          const previous = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(DirectoryObserve),
          )(row.request_json)
          if (Date.parse(previous.issuedAt) + refreshMs > at.getTime()) return null
          if (row.completed === 0 && Date.parse(previous.expiresAt) > at.getTime()) return previous
        }
        const document = {
          version: 1 as const,
          kind: "directory_observe" as const,
          hostId: peer.hostId,
          coordinatorHostId,
          generation: row.generation + 1,
          nonce: crypto.randomUUID(),
          issuedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + Math.min(35_000, leaseMs)).toISOString(),
        }
        const command = { ...document, signature: directoryMac(peer.credential, document) }
        yield* sql`UPDATE directory_peer_observations SET generation = ${command.generation}, request_json = ${JSON.stringify(command)}, completed = 0 WHERE host_id = ${peer.hostId}`
        yield* sql`DELETE FROM directory_observation_pages WHERE host_id = ${peer.hostId}`
        return command
      },
      (effect) => effect.pipe(sql.withTransaction, Effect.mapError(persistedError)),
    )

    const accept = Effect.fn("DirectoryRemoteStore.accept")(
      function* (page: DirectoryPage, at: Date, leaseMs: number) {
        const rows =
          yield* sql`SELECT request_json,completed,snapshot_json FROM directory_peer_observations WHERE host_id = ${page.hostId}`
        if (rows.length === 0) return "stale" as const
        const row = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            request_json: Schema.NullOr(Schema.String),
            completed: Schema.Int,
            snapshot_json: Schema.NullOr(Schema.String),
          }),
        )(rows[0])
        if (row.request_json === null) return "stale" as const
        const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DirectoryObserve))(
          row.request_json,
        )
        if (
          request.generation !== page.generation ||
          request.nonce !== page.nonce ||
          request.coordinatorHostId !== page.coordinatorHostId ||
          Date.parse(request.expiresAt) <= at.getTime() ||
          Date.parse(request.issuedAt) > at.getTime()
        )
          return "stale" as const
        if (row.completed === 1) return "duplicate" as const
        const existing =
          yield* sql`SELECT content,total FROM directory_observation_pages WHERE host_id = ${page.hostId} AND generation = ${page.generation} AND page = ${page.page}`
        if (
          existing.length > 0 &&
          (existing[0]?.content !== page.content || existing[0]?.total !== page.total)
        )
          return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
        if (page.page >= page.total)
          return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
        yield* sql`INSERT INTO directory_observation_pages(host_id,generation,page,total,content) VALUES(${page.hostId},${page.generation},${page.page},${page.total},${page.content}) ON CONFLICT DO NOTHING`
        const pages =
          yield* sql`SELECT page,total,content FROM directory_observation_pages WHERE host_id = ${page.hostId} AND generation = ${page.generation} ORDER BY page`
        const decoded = yield* Effect.forEach(pages, (value) =>
          Schema.decodeUnknownEffect(
            Schema.Struct({ page: Schema.Int, total: Schema.Int, content: Schema.String }),
          )(value),
        )
        if (decoded.some((value) => value.total !== page.total))
          return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
        if (decoded.length !== page.total) return "partial" as const
        const advertisement = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(DirectoryAdvertisement),
        )(decoded.map((value) => value.content).join(""), { onExcessProperty: "error" })
        const snapshot = advertisement.snapshot
        const previous =
          row.snapshot_json === null
            ? null
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DirectorySnapshot))(
                row.snapshot_json,
              )
        if (
          snapshot.runners.length !== 1 ||
          snapshot.runners[0]?.hostId !== page.hostId ||
          snapshot.runners[0].runnerId !== runnerIdForHost(page.hostId) ||
          !validCatalogClock(snapshot.runners[0].catalog, at) ||
          snapshot.runners[0].catalog.capabilities.some(
            (capability) => capability.identity.host !== page.hostId,
          )
        )
          return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
        const registrations = new Map(
          advertisement.registrations.map((registration) => [
            externalRecipientId(registration.publicKey),
            registration,
          ]),
        )
        if (
          registrations.size !== advertisement.registrations.length ||
          new Set(snapshot.agents.map((agent) => agent.recipientId)).size !== snapshot.agents.length
        )
          return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
        for (const agent of snapshot.agents) {
          if (
            agent.hostId !== page.hostId ||
            agent.runnerId !== runnerIdForHost(page.hostId) ||
            !Number.isFinite(Date.parse(agent.observedAt)) ||
            !Number.isFinite(Date.parse(agent.expiresAt)) ||
            Date.parse(agent.observedAt) > at.getTime() + 5_000
          )
            return yield* Effect.fail(new DirectoryError({ reason: "invalid_observation" }))
          if (agent.origin === "managed") {
            if (
              agent.runId === null ||
              agent.recipientId !== `managed:${page.hostId}:${agent.runId}`
            )
              return yield* Effect.fail(new DirectoryError({ reason: "ownership_conflict" }))
            const binding = previous?.agents.find((old) => old.recipientId === agent.recipientId)
            if (
              binding !== undefined &&
              (agent.bindingVersion < binding.bindingVersion ||
                (agent.bindingVersion === binding.bindingVersion &&
                  agent.endpoint !== null &&
                  binding.endpoint !== null &&
                  canonicalJson(agent.endpoint) !== canonicalJson(binding.endpoint)))
            )
              return yield* Effect.fail(new DirectoryError({ reason: "stale_binding" }))
            continue
          }
          const registration = registrations.get(agent.recipientId)
          if (
            registration === undefined ||
            registration.revision !== agent.bindingVersion ||
            canonicalJson(registration.endpoint) !== canonicalJson(agent.endpoint) ||
            agent.runId !== null
          )
            return yield* Effect.fail(new DirectoryError({ reason: "ownership_conflict" }))
          yield* verifyRegistration(registration, page.hostId)
          yield* claimExternalOwner(sql, registration)
        }
        yield* sql`UPDATE directory_peer_observations SET completed = 1, snapshot_json = ${JSON.stringify(snapshot)},
      observed_at = ${at.toISOString()}, expires_at = ${new Date(Date.parse(request.issuedAt) + leaseMs).toISOString()} WHERE host_id = ${page.hostId}`
        yield* sql`DELETE FROM directory_observation_pages WHERE host_id = ${page.hostId}`
        return "accepted" as const
      },
      (effect) => effect.pipe(sql.withTransaction, Effect.mapError(persistedError)),
    )

    const inventory = Effect.fn("DirectoryRemoteStore.inventory")(
      function* (hosts: ReadonlyArray<string>, at: Date) {
        const result: {
          agents: DirectorySnapshot["agents"][number][]
          runners: DirectorySnapshot["runners"][number][]
        } = { agents: [], runners: [] }
        const owners =
          yield* sql`SELECT recipient_id,host_id,revision FROM directory_owner_bindings`
        for (const hostId of hosts) {
          const rows =
            yield* sql`SELECT snapshot_json,observed_at,expires_at FROM directory_peer_observations WHERE host_id = ${hostId}`
          const row = rows[0]
          if (row === undefined || row.snapshot_json === null) {
            result.runners.push({
              runnerId: runnerIdForHost(hostId),
              hostId,
              status: "unavailable",
              observedAt: null,
              expiresAt: null,
              catalog: { capabilities: [], sources: [] },
            })
            continue
          }
          const value = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              snapshot_json: Schema.String,
              observed_at: Schema.String,
              expires_at: Schema.String,
            }),
          )(row)
          const snapshot = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(DirectorySnapshot),
          )(value.snapshot_json)
          const expired = Date.parse(value.expires_at) <= at.getTime()
          for (const runner of snapshot.runners) {
            const sources = runner.catalog.sources.map((source) => ({
              ...source,
              stale:
                expired ||
                source.stale ||
                source.freshUntil === null ||
                Date.parse(source.freshUntil) <= at.getTime(),
            }))
            result.runners.push({
              ...runner,
              status: expired ? "expired" : runner.status,
              observedAt: value.observed_at,
              expiresAt: value.expires_at,
              catalog: {
                sources,
                capabilities: runner.catalog.capabilities.map((capability) => ({
                  ...capability,
                  availability:
                    expired ||
                    sources.find((source) => source.executor === capability.identity.executor)
                      ?.stale !== false
                      ? "unavailable"
                      : capability.availability,
                })),
              },
            })
          }
          for (const agent of snapshot.agents) {
            if (
              agent.origin === "external" &&
              !owners.some(
                (owner) =>
                  owner.recipient_id === agent.recipientId &&
                  owner.host_id === hostId &&
                  owner.revision === agent.bindingVersion,
              )
            )
              continue
            const endpointExpired = expired || Date.parse(agent.expiresAt) <= at.getTime()
            result.agents.push({
              ...agent,
              status: endpointExpired && agent.status === "active" ? "expired" : agent.status,
              deliverable: !endpointExpired && agent.deliverable,
            })
          }
        }
        return result
      },
      (effect) => effect.pipe(Effect.mapError(persistedError)),
    )
    return DirectoryRemoteStore.of({ prepare, accept, inventory })
  }),
)
