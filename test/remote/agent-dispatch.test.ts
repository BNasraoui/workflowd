import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Option, Schedule, Scope, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { RemoteProbeProducer } from "../../src/remote/probe-producer"
import { McpQueries } from "../../src/mcp/queries"
import {
  OpenCodeCompletionProvider,
  runOpenCodeCompletionSourceIteration,
} from "../../src/kernel/opencode-completion-source"
import { remoteFixture } from "./agent-fixture"
import { callTool } from "../../src/mcp/tools"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js"
import { TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions"
import { routeRequest } from "../../src/http"
import { enqueueNextAgentHandoff } from "../../src/kernel/agent-handoff-reducer"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import {
  runOpenCodeResumeIteration,
  OpenCodeResumeProvider,
} from "../../src/kernel/opencode-resume-worker"
import { AGENT_WAKE_CONTRACT, AgentWakeResult } from "../../src/kernel/agent-wait-ingress"
import { toJsonSchemaObject } from "../../src/json"
import { RemoteAgentRunner } from "../../src/remote/agent-services"
import { RemoteTransport } from "../../src/remote/transport"
import { RemoteCommand } from "../../src/remote/contract"
import { agentFragments } from "../../src/remote/agent-contract"

const input = {
  family: "sol",
  host: "runner-b",
  repository: "fixture",
  prompt: "Do remote work",
  thinking: { effort: "xhigh" },
  speed: "fast",
}

test("a remote native model substitution refuses with retained snapshot, custody and one terminal mailbox", async () => {
  const fixture = await remoteFixture({ kind: "claude", reportedModel: "claude-substituted" })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const ingress = Context.get(centralContext, AgentRunIngress)
          const request = {
            intent: "research",
            host: "runner-b",
            repository: "fixture",
            prompt: "Do research",
          }
          const refusal = yield* ingress.register(request, new Date()).pipe(Effect.result)
          expect(refusal._tag).toBe("Failure")
          if (refusal._tag === "Failure")
            expect(refusal.failure).toMatchObject({
              reason: "model_not_available",
              mailboxId: expect.any(String),
            })
          const sql = Context.get(centralContext, SqlClient.SqlClient)
          const rows = yield* sql<{
            run_id: string
            caller_mailbox_id: string
            state: string
            diagnostic: string
            last_output_tokens: number
          }>`SELECT run_id,caller_mailbox_id,state,diagnostic,last_output_tokens FROM kernel_agent_runs`
          expect(rows).toHaveLength(1)
          const row = rows[0]!
          expect(row.diagnostic).toContain("selection_mismatch")
          expect(row.last_output_tokens).toBe(0)
          const run = yield* Context.get(centralContext, AgentRunStore).read(row.run_id)
          expect(run?.resolvedSelection?.model).toBe("claude-opus-5-5")
          expect(run?.nativeSessionId).toBe("remote-claude-session")
          expect(
            yield* Context.get(centralContext, McpQueries).readAgentMailbox(row.caller_mailbox_id),
          ).toHaveLength(1)
          yield* ingress.register(request, new Date()).pipe(Effect.result)
          const launches = yield* Effect.promise(() =>
            readFile(join(fixture.root, "launches.jsonl"), "utf8"),
          )
          expect(launches.trim().split("\n")).toHaveLength(1)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("concurrent runner outbox and delivery ticks do not fence an in-flight launch as a crash", async () => {
  const fixture = await remoteFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(fixture.runner)
          const runner = Option.getOrThrow(Context.getOption(context, RemoteAgentRunner))
          const now = new Date()
          const runId = "agent-run-concurrent-ticks"
          const selection = {
            host: "runner-b",
            catalogHost: "coordinator",
            executor: "codex:local",
            executorKind: "codex",
            provider: "openai",
            model: "gpt-6.10-sol",
            selectionModel: "gpt-6.10-sol",
            thinking: { effort: "xhigh" },
            availability: "available",
            evidence: "advertised",
          }
          for (const fragment of agentFragments(`agent-${runId}`, {
            runId,
            route: "selection-fixture",
            submission: input,
            selection,
            createdAt: now.toISOString(),
          }))
            yield* runner.receive({
              version: 1,
              kind: "agent_launch",
              commandId: `agent-${runId}-${fragment.index}`,
              jobId: runId,
              hostId: "runner-b",
              attempt: 1,
              generation: 1,
              issuedAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 60000).toISOString(),
              fragment,
            })
          yield* Effect.all([runner.tick(), runner.tick()], { concurrency: 2 })
          const sql = Context.get(context, SqlClient.SqlClient)
          const rows = yield* sql<{
            state: string
            reported: string | null
          }>`SELECT state,reported FROM remote_agent_launches WHERE run_id = ${runId}`
          expect(rows[0]?.reported).not.toBe("operator_required")
          expect((yield* Context.get(context, AgentRunStore).read(runId))?.nativeSessionId).toBe(
            "remote-native-session",
          )
          yield* Context.get(context, AgentRunStore)
            .read(runId)
            .pipe(
              Effect.repeat({
                until: (run) => run?.state === "completed",
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
            )
          yield* runner.tick()
          expect(
            yield* sql`SELECT state,reported FROM remote_agent_launches WHERE run_id = ${runId}`,
          ).toEqual([{ state: "terminal", reported: "completed" }])
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("a restart after the remote launch claim but before native custody fences the accepted run", async () => {
  const fixture = await remoteFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(fixture.runner)
          const runner = Option.getOrThrow(Context.getOption(context, RemoteAgentRunner))
          const runs = Context.get(context, AgentRunStore)
          const sql = Context.get(context, SqlClient.SqlClient)
          const runId = "agent-run-spent-accepted"
          yield* runs.create({
            runId,
            route: "fixture",
            providerId: "codex-cli",
            modelId: "gpt-6.10-sol",
            agent: "fixture",
            repository: "fixture",
            directory: join(fixture.root, "runner-b/worktrees/x"),
            prompt: "Task",
            promptSha256: "a".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          yield* sql`INSERT INTO remote_agent_launches (run_id,document,state) VALUES (${runId},'{}','launching')`
          yield* runner.tick()
          expect((yield* runs.read(runId))?.state).toBe("operator_required")
          expect(
            yield* sql`SELECT state,reported FROM remote_agent_launches WHERE run_id = ${runId}`,
          ).toEqual([{ state: "terminal", reported: "operator_required" }])
          expect(fixture.trees).toHaveLength(0)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("a durably received launch that expires while waiting for runner execution never starts", async () => {
  const fixture = await remoteFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(fixture.runner)
          const runner = Option.getOrThrow(Context.getOption(context, RemoteAgentRunner))
          const now = new Date()
          const runId = "agent-run-expired-pending"
          const selection = {
            host: "runner-b",
            catalogHost: "coordinator",
            executor: "codex:local",
            executorKind: "codex",
            provider: "openai",
            model: "gpt-6.10-sol",
            selectionModel: "gpt-6.10-sol",
            thinking: { effort: "xhigh" },
            availability: "available",
            evidence: "advertised",
          }
          for (const fragment of agentFragments(`agent-${runId}`, {
            runId,
            route: "selection-fixture",
            submission: input,
            selection,
            createdAt: now.toISOString(),
          }))
            yield* runner.receive({
              version: 1,
              kind: "agent_launch",
              commandId: `agent-${runId}-${fragment.index}`,
              jobId: runId,
              hostId: "runner-b",
              attempt: 1,
              generation: 1,
              issuedAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 30).toISOString(),
              fragment,
            })
          // Real time is the launch deadline under test; the CLI itself is isolated.
          yield* Effect.sleep("40 millis")
          yield* runner.tick()
          expect(fixture.trees).toHaveLength(0)
          expect(
            yield* Context.get(
              context,
              SqlClient.SqlClient,
            )`SELECT state,reported FROM remote_agent_launches WHERE run_id = ${runId}`,
          ).toEqual([{ state: "terminal", reported: "operator_required" }])
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("remote OpenCode verifies runner-local credentials before creating a workspace", async () => {
  const fixture = await remoteFixture({ kind: "opencode" })
  fixture.providerState.providers = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const result = yield* Context.get(centralContext, AgentRunIngress)
            .register(
              {
                family: "fable",
                harness: "opencode",
                host: "runner-b",
                repository: "fixture",
                prompt: "Use remote OpenCode",
              },
              new Date(),
            )
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({
              reason: "run_conflict",
              detail: expect.stringContaining("provider_not_authenticated"),
            })
          expect(fixture.trees).toHaveLength(0)
          expect(fixture.providerState.created).toHaveLength(0)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

for (const kind of ["claude", "opencode"] as const)
  test(`explicit remote ${kind} child preserves the selected harness and produces a terminal mailbox`, async () => {
    const fixture = await remoteFixture({ kind })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { centralContext } = yield* fixture.contexts
            const request =
              kind === "claude"
                ? {
                    intent: "research",
                    host: "runner-b",
                    repository: "fixture",
                    prompt: "Remote research",
                  }
                : {
                    family: "fable",
                    harness: "opencode" as const,
                    host: "runner-b",
                    repository: "fixture",
                    prompt: "Remote OpenCode",
                  }
            const receipt = yield* Context.get(centralContext, AgentRunIngress).register(
              request,
              new Date(),
            )
            expect(receipt.resolvedSelection).toMatchObject({
              host: "runner-b",
              catalogHost: "coordinator",
              executorKind: kind,
            })
            if (kind === "opencode") {
              const current = fixture.providerState.telemetry.get("ses_child")!
              fixture.providerState.telemetry.set("ses_child", {
                ...current,
                idle: true,
                outcome: "succeeded",
              })
            }
            const messages = yield* Context.get(centralContext, McpQueries)
              .readAgentMailbox(receipt.mailboxId)
              .pipe(
                Effect.repeat({
                  until: (rows) => rows.length > 0,
                  schedule: Schedule.spaced("10 millis"),
                }),
                Effect.timeout("5 seconds"),
              )
            expect(messages).toMatchObject([{ status: "completed", executor: kind }])
          }),
        ),
      )
    } finally {
      await fixture.cleanup()
    }
  }, 15000)

test("family dispatch executes exact settings on another host, transfers a 32 KiB prompt and publishes one durable result", async () => {
  const fixture = await remoteFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const ingress = Context.get(centralContext, AgentRunIngress)
          const runs = Context.get(centralContext, AgentRunStore)
          const queries = Context.get(centralContext, McpQueries)
          const request = { ...input, prompt: "🙂".repeat(8192) }
          const receipt = yield* ingress.register(request, new Date())
          expect(receipt.status).toBe("dispatched")
          expect(receipt.resolvedSelection).toMatchObject({
            host: "runner-b",
            catalogHost: "coordinator",
            model: "gpt-6.10-sol",
            thinking: { effort: "xhigh" },
            speed: { native: "fast" },
          })
          const terminal = yield* runs.read(receipt.runId).pipe(
            Effect.repeat({
              until: (run) => run?.state === "completed",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          )
          expect(terminal?.directory).toContain("runner-b/worktrees")
          expect(fixture.trees).toHaveLength(1)
          expect(fixture.trees[0]?.repository).toBe(join(fixture.root, "runner-b/repo"))
          fixture.changeCatalog()
          const replay = yield* ingress.register(request, new Date())
          expect(replay.mailboxId).toBe(receipt.mailboxId)
          expect(replay.resolvedSelection).toEqual(receipt.resolvedSelection)
          const messages = yield* queries.readAgentMailbox(receipt.mailboxId)
          expect(messages).toMatchObject([
            { run_id: receipt.runId, status: "completed", final_message: "Remote answer" },
          ])
          expect((yield* queries.jobStatus(receipt.runId))?.state).toBe("completed")
          const endpoint = `http://daemon/workflows/agent-runs/${receipt.runId}`
          const httpOptions = {
            webhookSecret: "unused",
            now: new Date(),
            agentRuns: { ...ingress, token: "fixture" },
          }
          const deniedHttp = yield* routeRequest(new Request(endpoint), httpOptions).pipe(
            Effect.provide(centralContext),
          )
          expect(deniedHttp.status).toBe(401)
          const statusHttp = yield* routeRequest(
            new Request(endpoint, { headers: { authorization: "Bearer fixture" } }),
            httpOptions,
          ).pipe(Effect.provide(centralContext))
          expect(statusHttp.status).toBe(200)
          expect(yield* Effect.promise(() => statusHttp.json())).toMatchObject({
            runId: receipt.runId,
            state: "completed",
            resolvedSelection: { host: "runner-b" },
          })
          const denied = yield* callTool(
            "job_status",
            { job_id: receipt.runId },
            { writesConfigured: true, writesAuthorized: false, now: () => new Date() },
          ).pipe(Effect.provide(centralContext))
          expect(denied.isError).toBe(true)
          const status = yield* callTool(
            "job_status",
            { job_id: receipt.runId },
            { writesConfigured: true, writesAuthorized: true, now: () => new Date() },
          ).pipe(Effect.provide(centralContext))
          expect(status.structuredContent).toMatchObject({
            state: "completed",
            run: { mailboxId: receipt.mailboxId, resolvedSelection: receipt.resolvedSelection },
          })
          const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "job_status")!
          expect(
            new AjvJsonSchemaValidator().getValidator(definition.outputSchema)(
              status.structuredContent,
            ).valid,
          ).toBe(true)
          const launches = yield* Effect.promise(() =>
            readFile(join(fixture.root, "launches.jsonl"), "utf8"),
          )
          const rows = launches
            .trim()
            .split("\n")
            .map((line) =>
              Schema.decodeUnknownSync(
                Schema.fromJsonString(
                  Schema.Struct({ prompt: Schema.String, args: Schema.Array(Schema.String) }),
                ),
              )(line),
            )
          expect(rows).toHaveLength(1)
          expect(rows[0]?.prompt).toBe(request.prompt)
          expect(rows[0]?.args).toContain("gpt-6.10-sol")
          expect(rows[0]?.args).toContain('model_reasoning_effort="xhigh"')
          expect(rows[0]?.args).toContain('service_tier="fast"')
          const probe = yield* Context.get(centralContext, RemoteProbeProducer).enqueue(
            { hostId: "runner-b", probeId: "legacy-compat" },
            new Date(),
          )
          const probeStatus = yield* queries.jobStatus(probe.jobId).pipe(
            Effect.repeat({
              until: (status) => status?.result !== null,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          )
          expect(probeStatus?.result?.result).toEqual({
            kind: "remote_probe",
            hostId: "runner-b",
            status: "succeeded",
          })
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("old runners refuse before run creation and never fall back locally", async () => {
  const fixture = await remoteFixture({ old: true })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext, runnerContext } = yield* fixture.contexts
          const outcome = yield* Context.get(centralContext, AgentRunIngress)
            .register(input, new Date())
            .pipe(Effect.result)
          expect(outcome._tag).toBe("Failure")
          if (outcome._tag === "Failure")
            expect(outcome.failure).toMatchObject({
              reason: "executor_unavailable",
              detail: expect.stringContaining("protocol v1"),
            })
          const sql = Context.get(centralContext, SqlClient.SqlClient)
          expect(yield* sql`SELECT run_id FROM kernel_agent_runs`).toHaveLength(0)
          expect(fixture.trees).toHaveLength(0)
          const fragment = agentFragments("agent-agent-run-unsupported", {
            runId: "agent-run-unsupported",
          })[0]!
          yield* Context.get(centralContext, RemoteTransport).publishFence({
            version: 1,
            kind: "fence",
            jobId: "agent-run-unsupported",
            hostId: "runner-b",
            generation: 1,
            disposition: "current",
            issuedAt: new Date().toISOString(),
          })
          yield* Context.get(centralContext, RemoteTransport).publishCommand({
            version: 1,
            kind: "agent_launch",
            commandId: "unsupported-command",
            jobId: "agent-run-unsupported",
            hostId: "runner-b",
            attempt: 1,
            generation: 1,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            fragment,
          })
          const runnerSql = Context.get(runnerContext, SqlClient.SqlClient)
          const rows = yield* runnerSql<{
            disposition: string
          }>`SELECT disposition FROM remote_runner_deliveries WHERE disposition = 'malformed'`.pipe(
            Effect.repeat({
              until: (rows) => rows.length > 0,
              schedule: Schedule.spaced("5 millis"),
            }),
            Effect.timeout("2 seconds"),
          )
          expect(rows).toEqual([{ disposition: "malformed" }])
          expect(
            yield* runnerSql`SELECT command_id FROM remote_runner_inbox WHERE command_id = 'unsupported-command'`,
          ).toHaveLength(0)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("remote failure delivers its diagnostic mailbox and wakes a local parent through terminal supervision", async () => {
  const fixture = await remoteFixture({ fail: true })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const ingress = Context.get(centralContext, AgentRunIngress)
          const receipt = yield* ingress.register(
            { ...input, parentSessionId: "ses_parent", resumePrompt: "Continue" },
            new Date(),
          )
          expect(receipt.wait).toBeDefined()
          const messages = yield* Context.get(centralContext, McpQueries)
            .readAgentMailbox(receipt.mailboxId)
            .pipe(
              Effect.repeat({
                until: (rows) => rows.length > 0,
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
            )
          expect(messages).toMatchObject([
            {
              status: "operator_required",
              end_reason: expect.stringContaining("exit 23"),
              final_message: "Remote answer",
            },
          ])
          const result = yield* runOpenCodeCompletionSourceIteration({
            ...fixture.identity,
            observationTimeoutMs: 1000,
            now: () => new Date(),
          }).pipe(
            Effect.provide(centralContext),
            Effect.provideService(OpenCodeCompletionProvider, {
              sessionExists: async () => true,
              sessionFinished: async () => false,
              listMessages: async () => [],
              subscribeEvents: async () => ({ async *[Symbol.asyncIterator]() {} }),
            }),
          )
          expect(result.status).toBe("completed")
          yield* enqueueNextAgentHandoff(new Date()).pipe(Effect.provide(centralContext))
          yield* runKernelJobIteration({
            workerId: "fixture",
            now: () => new Date(),
            leaseDurationMs: 60000,
            retryDelayMs: 0,
          }).pipe(Effect.provide(centralContext))
          const prompts: string[] = []
          const resumeProvider = {
            sessionExists: async () => true,
            sessionFinished: async () => true,
            listMessages: async () => [],
            promptAsync: async (input: { prompt: string }) => {
              prompts.push(input.prompt)
            },
            subscribeEvents: async () => ({
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "message.updated" as const,
                  sessionID: "ses_parent",
                  message: { role: "assistant" as const, time: { created: 1, completed: 2 } },
                }
              },
            }),
            generate: async () => ({ acknowledged: true, summary: "received" }),
          }
          const resumed = yield* runOpenCodeResumeIteration({
            ...fixture.identity,
            workerId: "fixture",
            now: () => new Date(),
            leaseDurationMs: 60000,
            heartbeatIntervalMs: 20000,
            contracts: [
              {
                name: AGENT_WAKE_CONTRACT.name,
                version: 1,
                schema: AgentWakeResult,
                jsonSchema: toJsonSchemaObject(AgentWakeResult),
                maxOutputBytes: 16384,
                agent: "fixture",
                model: { providerID: "fixture", modelID: "fixture" },
              },
            ],
          }).pipe(
            Effect.provide(centralContext),
            Effect.provideService(OpenCodeResumeProvider, resumeProvider),
          )
          expect(resumed.status).toBe("completed")
          expect(
            prompts.map((prompt) =>
              Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
              )(prompt),
            ),
          ).toMatchObject([
            {
              task: "Continue",
              terminal: {
                run_id: receipt.runId,
                status: "operator_required",
                final_message: "Remote answer",
              },
            },
          ])
          yield* ingress.cancel(receipt.runId, new Date())
          expect(
            (yield* Context.get(centralContext, AgentRunStore).read(receipt.runId))?.state,
          ).toBe("cancelled")
          expect(
            yield* Context.get(centralContext, McpQueries).readAgentMailbox(receipt.mailboxId),
          ).toHaveLength(1)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("coordinator and runner restart plus reordered redelivery retain one native launch and the frozen host snapshot", async () => {
  const fixture = await remoteFixture({ hold: true })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* Scope.make()
          const initial = yield* fixture.startContexts(first)
          const receipt = yield* Context.get(initial.centralContext, AgentRunIngress).register(
            input,
            new Date(),
          )
          yield* Scope.close(first, Exit.succeed(undefined))
          fixture.changeCatalog()
          const { centralContext, runnerContext } = yield* fixture.contexts
          const ingress = Context.get(centralContext, AgentRunIngress)
          const replay = yield* ingress.register(input, new Date())
          expect(replay.status).toBe("duplicate")
          expect(replay.resolvedSelection).toEqual(receipt.resolvedSelection)
          const sql = Context.get(centralContext, SqlClient.SqlClient)
          const commands = yield* sql<{
            envelope: string
          }>`SELECT envelope FROM remote_agent_outbox WHERE json_extract(envelope,'$.kind') = 'agent_launch' ORDER BY rowid DESC`
          for (const row of commands) {
            const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteCommand))(
              row.envelope,
            )
            yield* Option.getOrThrow(Context.getOption(runnerContext, RemoteAgentRunner)).receive(
              command,
            )
            yield* Option.getOrThrow(Context.getOption(runnerContext, RemoteAgentRunner)).receive(
              command,
            )
          }
          yield* ingress.cancel(receipt.runId, new Date())
          const messages = yield* Context.get(centralContext, McpQueries).readAgentMailbox(
            receipt.mailboxId,
          )
          expect(messages).toHaveLength(1)
          expect(messages[0]?.status).toBe("cancelled")
          const launches = yield* Effect.promise(() =>
            readFile(join(fixture.root, "launches.jsonl"), "utf8"),
          )
          expect(launches.trim().split("\n")).toHaveLength(1)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("cancellation before fragmented launch and a spent uncertain claim never execute a replacement", async () => {
  const fixture = await remoteFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { runnerContext } = yield* fixture.contexts
          const runner = Option.getOrThrow(Context.getOption(runnerContext, RemoteAgentRunner))
          const now = new Date()
          const runId = "agent-run-cancelled-before-transfer"
          const base = {
            version: 1 as const,
            jobId: runId,
            hostId: "runner-b",
            attempt: 1,
            generation: 1,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 60000).toISOString(),
          }
          yield* runner.receive({ ...base, kind: "agent_cancel", commandId: "cancel-first" })
          const selection = {
            host: "runner-b",
            catalogHost: "coordinator",
            executor: "codex:local",
            executorKind: "codex",
            provider: "openai",
            model: "gpt-6.10-sol",
            selectionModel: "gpt-6.10-sol",
            thinking: { effort: "xhigh" },
            availability: "available",
            evidence: "advertised",
          }
          const fragments = agentFragments(`agent-${runId}`, {
            runId,
            route: "selection-fixture",
            submission: { ...input, prompt: "🙂".repeat(8192) },
            selection,
            createdAt: now.toISOString(),
          })
          for (const fragment of [...fragments].reverse())
            yield* runner.receive({
              ...base,
              kind: "agent_launch",
              commandId: `agent-${runId}-${fragment.index}`,
              fragment,
            })
          yield* runner.tick()
          const sql = Context.get(runnerContext, SqlClient.SqlClient)
          yield* sql`INSERT INTO remote_agent_launches (run_id,state,document) VALUES ('agent-run-uncertain','launching','{}')`
          yield* runner.tick()
          const states = yield* sql<{
            state: string
            reported: string
          }>`SELECT state,reported FROM remote_agent_launches ORDER BY rowid`
          expect(states).toEqual([
            { state: "terminal", reported: "cancelled" },
            { state: "terminal", reported: "operator_required" },
          ])
          expect(fixture.trees).toHaveLength(0)
          expect(yield* sql`SELECT run_id FROM kernel_agent_runs`).toHaveLength(0)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)

test("remote cancellation stops the owned process and returns a confirmed terminal mailbox", async () => {
  const fixture = await remoteFixture({ hold: true })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const ingress = Context.get(centralContext, AgentRunIngress)
          const receipt = yield* ingress.register(input, new Date())
          yield* ingress.cancel(receipt.runId, new Date())
          expect(
            (yield* Context.get(centralContext, AgentRunStore).read(receipt.runId))?.state,
          ).toBe("cancelled")
          expect(
            yield* Context.get(centralContext, McpQueries).readAgentMailbox(receipt.mailboxId),
          ).toMatchObject([{ status: "cancelled" }])
          const launches = yield* Effect.promise(() =>
            readFile(join(fixture.root, "launches.jsonl"), "utf8"),
          )
          expect(launches.trim().split("\n")).toHaveLength(1)
          const native = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
          )(launches.trim())
          const alive = yield* Effect.promise(() =>
            readFile(`/proc/${native.pid}/stat`, "utf8").then(
              (stat) => !/\) [ZX] /.test(stat),
              (error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT")
                  return false
                throw error
              },
            ),
          )
          expect(alive).toBe(false)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
}, 15000)
