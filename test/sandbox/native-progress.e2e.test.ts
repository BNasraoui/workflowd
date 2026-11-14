import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeNativeExecutionStore, makeNativeCli } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeAgentRunCliDispatcher } from "../../src/kernel/agent-run-cli"
import { AgentRunRefusalError } from "../../src/kernel/agent-run-ingress"
import { disposableSsh } from "./fixtures/ssh.mjs"

for (const behavior of [
  "productive",
  "idle",
  "hung tool",
  "dead process",
  "progress SQL fault",
] as const) {
  test(`real interactive turns and production observer window: ${behavior}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-progress-"))
    const socket = join(root, "gateway.sock")
    const ssh = await disposableSsh(() =>
      [
        fixtureExecutable("node"),
        resolve("test/sandbox/fixtures/native-pty.mjs"),
        root,
        fixtureExecutable("claude"),
        socket,
      ].join(" "),
    )
    await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(root, "access.mjs"),
      'console.log(JSON.stringify({token:"fixture-access",token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))',
    )
    for (const [provider, command] of [
      [
        "run-capability",
        `${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}`,
      ],
      ["provider-access", `${process.execPath} ${join(root, "access.mjs")}`],
    ])
      await writeFile(
        join(root, `noscope/providers/${provider}.toml`),
        `contract_version = 1\n[commands]\nmint = "${command}"\n`,
        { mode: 0o600 },
      )
    const completed = Promise.withResolvers<{ state: string }>()
    const finishedUpstream = Promise.withResolvers<void>()
    let turns = 0,
      toolResults = 0
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { runs, leases, sql } = yield* seedCapabilityRun(Date.now(), true)
          yield* sql`UPDATE kernel_agent_runs SET model_id='claude-opus-4-6' WHERE run_id='run'`
          const gateway = yield* makeCapabilityGateway(
            {
              noscope: { binary: fixtureExecutable("noscope"), configHome: root },
              providerId: "anthropic",
              credentialRole: "fixture",
              maxStreams: 4,
              maxStreamsPerRun: 4,
            },
            async (_url, input) => {
              const body = Schema.decodeUnknownSync(
                Schema.fromJsonString(
                  Schema.Struct({
                    model: Schema.String,
                    tools: Schema.optionalKey(Schema.Array(Schema.Json)),
                    messages: Schema.Array(
                      Schema.Struct({
                        content: Schema.Union([
                          Schema.String,
                          Schema.Array(Schema.Struct({ type: Schema.String })),
                        ]),
                      }),
                    ),
                  }),
                ),
              )(Buffer.from(input.body).toString())
              const main = (body.tools?.length ?? 0) > 0
              if (main) {
                turns++
                const content = body.messages.at(-1)?.content
                if (Array.isArray(content))
                  toolResults += content.filter((item) => item.type === "tool_result").length
                await Bun.sleep(800)
                if (behavior === "progress SQL fault" && turns === 2)
                  await Effect.runPromise(sql`CREATE TRIGGER fail_native_progress BEFORE UPDATE OF last_output_tokens ON kernel_agent_runs
                BEGIN SELECT RAISE(FAIL,'injected progress persistence failure'); END`)
              }
              const action =
                main &&
                (((behavior === "productive" || behavior === "progress SQL fault") && turns <= 8) ||
                  (behavior === "hung tool" && turns === 1))
              const block = action
                ? { type: "tool_use", id: `tool_${turns}`, name: "Bash", input: {} }
                : { type: "text", text: "" }
              const events = [
                {
                  type: "message_start",
                  message: {
                    id: `msg_${turns}`,
                    type: "message",
                    role: "assistant",
                    model: body.model,
                    content: [],
                    stop_reason: null,
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
                { type: "content_block_start", index: 0, content_block: block },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: action
                    ? {
                        type: "input_json_delta",
                        partial_json: JSON.stringify({
                          command:
                            behavior === "hung tool"
                              ? "python3 -c 'import time; time.sleep(30)'"
                              : "python3 -c 'print(42)'",
                          description: "Bounded fixture work",
                        }),
                      }
                    : { type: "text_delta", text: "Synthetic result" },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: action ? "tool_use" : "end_turn", stop_sequence: null },
                  usage: { output_tokens: 3 },
                },
                { type: "message_stop" },
              ]
              if (main && !action) finishedUpstream.resolve()
              return new Response(
                events
                  .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
                  .join(""),
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          )
          const grant = yield* gateway.bind(
            yield* gateway.challenge("run", transport),
            "progress-jti",
          )
          yield* leases.bind("run", 78, 1, transport)
          const native = yield* makeNativeExecutionStore
          const invocation = yield* native.reserve("run")
          const now = new Date().toISOString()
          yield* sql`INSERT INTO kernel_working_resources(resource_id,owning_host_id,absolute_path,kind,state,created_at,updated_at)
          VALUES('resource','fixture-controller',${root},'workspace','reserved',${now},${now})`
          yield* sql`INSERT INTO kernel_sessions(session_id,provider_kind,provider_version,provider_id,server_id,owning_host_id,endpoint_alias,endpoint_identity,native_session_id,resource_id,state,revision,created_at,updated_at)
          VALUES('session','claude',1,'anthropic','fixture-ssh','fixture-controller','fixture','claude-cli://fixture-ssh',${invocation.session_id},'resource','active',1,${now},${now})`
          yield* sql`UPDATE kernel_agent_runs SET state='verified',session_id='session',resource_id='resource',native_session_id=${invocation.session_id} WHERE run_id='run'`
          const cli = yield* makeNativeCli({
            runId: "run",
            invocation,
            transport,
            sshArguments: ssh.args,
          })
          // Reproduce the reviewed first-event-only observer contract against the
          // same real CLI/tool turns. Used only for the separately recorded RED run.
          const observedCli =
            process.env.WORKFLOWD_FIXTURE_PROGRESS_MODE === "first-only"
              ? {
                  ...cli,
                  spawn: (input: Parameters<typeof cli.spawn>[0]) =>
                    cli.spawn(input).pipe(
                      Effect.map((owned) => ({
                        ...owned,
                        events: {
                          async *[Symbol.asyncIterator]() {
                            let seen = false
                            for await (const event of owned.events) {
                              if (event.type === "provider.response") {
                                if (seen) continue
                                seen = true
                              }
                              yield event
                            }
                          },
                        },
                      })),
                    ),
                }
              : cli
          const server = Bun.serve({
            unix: socket,
            async fetch(request) {
              if (request.headers.get("authorization") !== "Bearer fixture-sentinel")
                return new Response(null, { status: 403 })
              const url = new URL(request.url),
                headers = new Headers(request.headers)
              headers.set("authorization", `Bearer ${grant.token}`)
              return Effect.runPromise(
                gateway.handle(
                  grant.binding,
                  new Request(
                    "http://capability.invalid/capabilities/v1/providers/anthropic" +
                      url.pathname +
                      url.search,
                    { method: request.method, headers, body: await request.arrayBuffer() },
                  ),
                ),
              )
            },
          })
          try {
            const unused = () => Effect.die("Unexpected fixture boundary")
            const dispatcher = makeAgentRunCliDispatcher({
              executor: { kind: "claude", sessionCustodyId: (value) => value },
              cli,
              store: runs,
              worktrees: { create: unused },
              signals: { wake: () => Effect.void, subscribe: unused },
              ensureResource: unused,
              ensureSession: unused,
              refuse: (reason, detail) => new AgentRunRefusalError({ reason, detail }),
              verifyTimeoutMs: 20000,
              progressWindowMs: 3000,
              sandbox: {
                prepareNative: unused,
                finishNative: (_run, terminal) => Effect.sync(() => completed.resolve(terminal)),
                launch: unused,
                cancel: unused,
                observe: unused,
                owns: () => Effect.succeed(true),
                provider: unused,
                heartbeat: Effect.void,
                iteration: Effect.void,
              },
            })
            const began = Date.now()
            yield* dispatcher.resumeNative(
              (yield* runs.read("run"))!,
              observedCli,
              "Perform the bounded synthetic turns",
            )
            if (behavior === "dead process")
              yield* Effect.promise(async () => {
                const custodian = (await readFile(join(root, "custodian.pid"), "utf8")).trim()
                expect(custodian).toMatch(/^[0-9]+$/)
                // Exact owned parent only. No host process inventory or name-based kill.
                const child = (
                  await readFile(`/proc/${custodian}/task/${custodian}/children`, "utf8")
                ).trim()
                expect(child).toMatch(/^[0-9]+$/)
                expect((await readFile(`/proc/${child}/cmdline`, "utf8")).split("\0")[0]).toBe(
                  fixtureExecutable("claude"),
                )
                process.kill(Number(child), "SIGKILL")
              })
            if (behavior === "productive") {
              const progressed = yield* Effect.promise(() =>
                Promise.race([
                  finishedUpstream.promise.then(() => true),
                  completed.promise.then(() => false),
                ]),
              )
              expect(progressed).toBe(true)
              expect(Date.now() - began).toBeGreaterThan(6000)
              expect((yield* native.read("run"))?.state).toBe("running")
              expect((yield* runs.read("run"))?.lastOutputTokens).toBeGreaterThan(3)
              const results = yield* makeNativeResultStore
              yield* results.submit(grant.binding, {
                revision: 0,
                completion: {
                  branch: "fixture/result",
                  title: "Result",
                  body: "Result",
                  commitMessage: "Result",
                },
              })
              const process = yield* cli.attach({ runId: "run" })
              yield* process!.finish!(1)
            }
            const outcome = yield* Effect.promise(() => completed.promise).pipe(
              Effect.timeout("10 seconds"),
            )
            expect(outcome.state).toBe(
              behavior === "productive" ? "completed" : "operator_required",
            )
            expect((yield* native.read("run"))?.state).toBe("stopped")
            if (behavior === "progress SQL fault") {
              expect(turns).toBeGreaterThanOrEqual(2)
              expect(turns).toBeLessThan(9)
            } else {
              expect(toolResults).toBe(behavior === "productive" ? 8 : 0)
              expect(turns).toBe(behavior === "productive" ? 9 : 1)
            }
          } finally {
            yield* Effect.promise(() => server.stop(true))
          }
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      await ssh.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
}
