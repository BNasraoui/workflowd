import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { McpQueries } from "../../src/mcp/queries"
import { RemoteTransport } from "../../src/remote/transport"
import { remoteFixture } from "./agent-fixture"

test("real JetStream carries bounded agent launch fragments and a terminal result without a second native execution", async () => {
  const name = `workflowd-agent-broker-${process.pid}`
  const port = 49500 + (process.pid % 400)
  const docker = async (args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) throw new Error(stderr)
  }
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:4222`,
    "nats:2.11.8-alpine",
    "-js",
  ])
  const fixture = await remoteFixture({ server: `nats://127.0.0.1:${port}`, runtime: true })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const ingress = Context.get(centralContext, AgentRunIngress)
          const receipt = yield* ingress.register(
            { family: "sol", host: "runner-b", repository: "fixture", prompt: "🙂".repeat(8192) },
            new Date(),
          )
          const runs = Context.get(centralContext, AgentRunStore)
          yield* runs.read(receipt.runId).pipe(
            Effect.repeat({
              until: (run) => run?.state === "completed",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("10 seconds"),
          )
          const sql = Context.get(centralContext, SqlClient.SqlClient)
          const commands = yield* sql<{
            envelope: string
          }>`SELECT envelope FROM remote_agent_outbox WHERE json_extract(envelope,'$.kind') = 'agent_launch'`
          expect(commands.length).toBeGreaterThan(1)
          for (const row of [...commands].reverse()) {
            const bytes = new TextEncoder().encode(row.envelope)
            expect(bytes.byteLength).toBeLessThanOrEqual(16384)
            yield* Context.get(centralContext, RemoteTransport).publishRaw(
              "workflowd.v1.commands.runner-b",
              bytes,
            )
          }
          const replay = yield* ingress.register(
            { family: "sol", host: "runner-b", repository: "fixture", prompt: "🙂".repeat(8192) },
            new Date(),
          )
          expect(replay.status).toBe("duplicate")
          expect(replay.mailboxId).toBe(receipt.mailboxId)
          expect(
            yield* Context.get(centralContext, McpQueries).readAgentMailbox(receipt.mailboxId),
          ).toMatchObject([{ status: "completed", final_message: "Remote answer" }])
          const launches = yield* Effect.promise(() =>
            readFile(join(fixture.root, "launches.jsonl"), "utf8"),
          )
          expect(launches.trim().split("\n")).toHaveLength(1)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
    await docker(["rm", "-f", name])
  }
}, 30000)
