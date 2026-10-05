import { expect, test } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { DirectoryStore } from "../../src/directory/store"
import { AgentRunProvider } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { runAgentRunWatchdogIteration } from "../../src/kernel/agent-run-watchdog"
import {
  ManagedDirectoryObservationsLive,
  runManagedDirectoryObservation,
} from "../../src/directory/managed-observations"
import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "../../src/opencode/adapter"
import { WorkSignalLive } from "../../src/work-signal"
import { makeResidentStore } from "../../src/resident/store"
import { makeSubscriptions } from "../../src/resident/subscriptions"
import { managedStores, seedManaged } from "./managed-fixture"

test("all quiet bindings and parked residents renew without completion supervision, then expire and reacquire", async () => {
  const calls: string[] = []
  let available = true
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const id = new URL(request.url).pathname.split("/").at(-1) ?? ""
      calls.push(id)
      return available
        ? Response.json({
            data: {
              id,
              projectID: "fixture",
              cost: 0,
              tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
              location: { directory: `/fixture/${id.slice(4)}` },
            },
          })
        : new Response(null, { status: 503 })
    },
  })
  try {
    const adapter = new SdkOpenCodeAdapter(
      makeOpenCodeSdkClient(
        OpenCode.make({ baseUrl: native.url.toString() }).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        const at = new Date("2026-10-05T00:00:00Z")
        yield* directory.bindLocalHost("host-a")
        for (const id of ["a", "b", "parked"]) yield* seedManaged(id, at, native.url.toString())
        yield* seedManaged("other-endpoint", at, "http://foreign.invalid")
        const resident = yield* makeResidentStore
        yield* resident.attach(
          "parked",
          "ses_parked",
          "/fixture/parked",
          "same-model",
          "opencode",
          "b".repeat(64),
        )
        yield* resident.started("ses_parked", "inert-turn")
        yield* (yield* makeSubscriptions).register("ses_parked", {
          kind: "ci",
          repository: "o/r",
          sha: "a".repeat(40),
        })
        const observe = (seconds: number) =>
          runManagedDirectoryObservation({
            endpointIdentity: native.url.toString(),
            leaseMs: 90_000,
            now: () => new Date(at.getTime() + seconds * 1000),
          }).pipe(Effect.provideService(AgentRunProvider, adapter))
        yield* observe(60)
        expect(
          (yield* directory.managed(new Date(at.getTime() + 91_000), 90_000))
            .filter((r) => r.runId !== "other-endpoint")
            .every((r) => r.deliverable),
        ).toBe(true)
        yield* observe(120)
        const current = yield* directory.managed(new Date(at.getTime() + 151_000), 90_000)
        expect(
          current.filter((r) => r.runId !== "other-endpoint").every((r) => r.deliverable),
        ).toBe(true)
        expect(calls.filter((id) => id === "ses_parked")).toHaveLength(2)
        expect(calls).not.toContain("ses_other-endpoint")
        // Exclude the quiet workers so only the durable parked wait is eligible for inspection.
        const runs = yield* AgentRunStore
        for (const id of ["a", "b", "other-endpoint"])
          yield* runs.operatorRequired({ runId: id, diagnostic: "fixture terminal", now: at })
        calls.length = 0
        const supervised = yield* runAgentRunWatchdogIteration({
          now: () => new Date(at.getTime() + 151_000),
          progressWindowMs: 1000,
          staleAfterMs: 0,
          unsupervisedExecutorKinds: ["codex", "claude"],
        }).pipe(Effect.provideService(AgentRunProvider, adapter), Effect.provide(WorkSignalLive))
        expect(supervised).toBe("idle")
        expect(calls).toHaveLength(0)
        expect(
          (yield* directory.managed(new Date(at.getTime() + 211_000), 90_000)).find(
            (r) => r.runId === "parked",
          )?.status,
        ).toBe("expired")
        available = false
        yield* observe(212)
        expect(
          (yield* directory.managed(new Date(at.getTime() + 212_000), 90_000)).find(
            (r) => r.runId === "parked",
          )?.status,
        ).toBe("unavailable")
        available = true
        yield* observe(213)
        expect(
          (yield* directory.managed(new Date(at.getTime() + 213_000), 90_000)).find(
            (r) => r.runId === "parked",
          ),
        ).toMatchObject({ recipientId: "managed:host-a:parked", deliverable: true })
        expect(yield* runs.read("parked")).toMatchObject({
          state: "verified",
          attempt: 1,
          updatedAt: at,
        })
        expect(yield* resident.read("ses_parked")).toMatchObject({
          state: "waiting",
          closure_confirmed: 0,
        })
      }).pipe(Effect.provide(managedStores())),
    )
  } finally {
    await native.stop(true)
  }
})

test("scoped native directory refresh runs repeatedly and stops when its owner closes", async () => {
  let reads = 0
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      reads++
      return Response.json({
        data: {
          id: "ses_scoped",
          projectID: "fixture",
          cost: 0,
          tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: "/fixture/scoped" },
        },
      })
    },
  })
  try {
    const adapter = new SdkOpenCodeAdapter(
      makeOpenCodeSdkClient(
        OpenCode.make({ baseUrl: native.url.toString() }).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )
    const live = ManagedDirectoryObservationsLive({
      hostId: "host-a",
      endpointIdentity: native.url.toString(),
      refreshMs: 10,
      leaseMs: 100,
      now: () => new Date(),
    }).pipe(Layer.provide(Layer.succeed(AgentRunProvider, adapter)))
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        yield* directory.bindLocalHost("host-a")
        yield* seedManaged("scoped", new Date(), native.url.toString())
        yield* Effect.gen(function* () {
          yield* Effect.tryPromise(async () => {
            if (reads < 2) throw new Error("Await native refresh")
          }).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }))
          expect((yield* directory.managed(new Date(), 100))[0]?.deliverable).toBe(true)
        }).pipe(Effect.provide(live))
        const stoppedAt = reads
        yield* Effect.sleep("25 millis")
        expect(reads).toBe(stoppedAt)
      }).pipe(Effect.provide(managedStores())),
    )
  } finally {
    await native.stop(true)
  }
})
