import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { managedStores, seedManaged } from "../directory/managed-fixture"
import { DirectoryStore } from "../../src/directory/store"
import { makeMessageStore } from "../../src/messaging/store"
import { makeMessageDelivery } from "../../src/messaging/delivery"
import { makeResidentStore } from "../../src/resident/store"
import { makeOpenCodeMailbox } from "../../src/resident/opencode"
import { ResidentCodex, ResidentCodexLive } from "../../src/resident/service"
import { RpcClient } from "../../src/resident/rpc"
import type { startAppServer } from "../../src/resident/process"

const message = (recipient: string) => ({
  id: crypto.randomUUID(),
  sender: "host:host-a",
  recipient,
  correlation: "progress",
  replyTo: null,
  payload: { type: "note", version: 1, data: "inert input" },
})

test.each(["codex", "opencode"] as const)(
  "%s native inbox advances beyond proof-blocked input and retries after proof returns",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        const inbox = yield* makeResidentStore
        const messages = yield* makeMessageStore
        const delivery = yield* makeMessageDelivery("host-a")
        yield* directory.bindLocalHost("host-a")
        for (const id of ["parked", "healthy"]) {
          yield* seedManaged(id, new Date(), "local://progress", kind)
          yield* inbox.attach(id, `ses_${id}`, `/fixture/${id}`, null, kind)
          yield* inbox.started(`ses_${id}`, "fixture-running")
          yield* inbox.park(`ses_${id}`)
          yield* directory.observeManaged(
            id,
            { nativeSessionId: `ses_${id}`, directory: `/fixture/${id}` },
            new Date(),
          )
        }
        const calls: string[] = []
        const pids = new Map<string, number>()
        const start: typeof startAppServer = (options) => {
          const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          pids.set(options.env?.WORKFLOWD_RUN_ID ?? "", child.pid)
          const rpc = new RpcClient(
            (line) => {
              const frame = Schema.decodeUnknownSync(
                Schema.Struct({
                  id: Schema.Number,
                  method: Schema.String,
                  params: Schema.Record(Schema.String, Schema.Unknown),
                }),
              )(JSON.parse(line))
              const threadId = Schema.decodeUnknownSync(Schema.String)(frame.params.threadId)
              const cwd = `/fixture/${threadId.slice("ses_".length)}`
              if (frame.method === "thread/queue/add" || frame.method === "turn/start")
                calls.push(threadId)
              rpc.receive(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      id: threadId,
                      cwd,
                      status: { type: "active" },
                      canAcceptDirectInput: true,
                      turns: [{ id: "fixture-running", status: "inProgress", items: [] }],
                    },
                    cwd,
                  },
                }),
              )
            },
            () => {},
          )
          return {
            pid: child.pid,
            rpc,
            initialize: async () => {},
            close: async () => {
              rpc.close()
              await child.stdin.end()
              await child.exited
            },
          }
        }
        const exercise = (tick: Effect.Effect<void, unknown>) =>
          Effect.gen(function* () {
            const agents = yield* directory.managed(new Date(), 90000)
            const healthy = agents.find((agent) => agent.runId === "healthy")!
            const blocked = agents.find((agent) => agent.runId === "parked")!
            expect(healthy.deliverable && blocked.deliverable).toBe(true)
            const control = message(healthy.recipientId)
            yield* messages.accept(control, healthy, "host-a")
            yield* delivery.pass()
            yield* tick
            expect(calls).toEqual(["ses_healthy"])
            calls.length = 0
            yield* delivery.pass()
            const first = message(blocked.recipientId)
            yield* messages.accept(first, blocked, "host-a")
            for (let index = 1; index < 100; index++)
              yield* messages.accept(message(blocked.recipientId), blocked, "host-a")
            const expected = message(healthy.recipientId)
            yield* messages.accept(expected, healthy, "host-a")
            yield* delivery.pass()
            yield* delivery.pass()
            yield* directory.unavailableManaged("parked", "ses_parked")
            for (let index = 0; index < 4; index++) yield* tick
            expect(calls).toEqual(["ses_healthy"])
            expect(yield* inbox.deliveryState(`message:${expected.id}`)).toBe("delivered")
            expect(yield* inbox.deliveryState(`message:${first.id}`)).toBe("prepared")
            yield* directory.observeManaged(
              "parked",
              { nativeSessionId: "ses_parked", directory: "/fixture/parked" },
              new Date(),
            )
            for (let index = 0; index < 4; index++) yield* tick
            expect(calls.filter((id) => id === "ses_parked")).toHaveLength(100)
            expect(calls.filter((id) => id === "ses_healthy")).toHaveLength(1)
            expect(yield* inbox.deliveryState(`message:${first.id}`)).toBe("delivered")
          })
        if (kind === "opencode") {
          const mailbox = yield* makeOpenCodeMailbox(
            {
              owningHostId: "host-a",
              providerId: "fixture",
              serverId: "fixture",
              endpointAlias: "local",
              endpointIdentity: "local://progress",
              providerVersion: 1,
              socket: "/unused.sock",
              repositories: [],
            },
            {
              sessionExists: () => Effect.succeed(true),
              setSessionEnvironment: () => Effect.void,
              promptSession: (input) =>
                Effect.sync(() => {
                  calls.push(input.sessionID)
                }),
            },
          )
          yield* exercise(mailbox.tick)
        } else {
          yield* Effect.gen(function* () {
            const resident = yield* ResidentCodex
            yield* exercise(
              Effect.gen(function* () {
                const response = yield* resident.route(
                  new Request("http://resident/subscriptions", {
                    method: "POST",
                    body: JSON.stringify({
                      runId: "healthy",
                      selector: { kind: "agent_run", run_id: "parked" },
                    }),
                  }),
                  pids.get("healthy"),
                )
                expect(response?.status).toBe(202)
              }),
            )
          }).pipe(
            Effect.provide(
              ResidentCodexLive(
                {
                  socket: `/tmp/workflowd-message-progress-${process.pid}.sock`,
                  home: "/unused",
                  directoryRefreshMs: 90000,
                },
                "inert",
                {
                  token: "fixture",
                  repositories: [],
                  servers: [],
                  auth: { mode: "token", token: "fixture" },
                },
                start,
              ),
            ),
          )
        }
      }).pipe(Effect.scoped, Effect.provide(managedStores()), Effect.provide(TestClock.layer())),
    ),
)
