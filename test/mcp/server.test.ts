import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { startMcpServer, type StartedMcpServer } from "../../src/mcp-server"
import { removeDatabase } from "../kernel/job-store-harness"

const databasePath = "test-mcp-server.db"
let started: StartedMcpServer

beforeAll(async () => {
  await removeDatabase(databasePath)
  started = await Effect.runPromise(
    startMcpServer({
      WORKFLOWD_MCP_PORT: "0",
      WORKFLOWD_DATABASE_PATH: databasePath,
      WORKFLOWD_MCP_TOKEN: "integration-token",
    }),
  )
})

afterAll(async () => {
  await started.stop()
  await removeDatabase(databasePath)
})

const RpcEnvelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})
const ToolCallResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
})
const ToolList = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
  ),
})
const InitializeResult = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.String }),
})

const rpc = async (
  method: string,
  params: unknown,
  headers?: Record<string, string>,
): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  expect(response.status).toBe(200)
  const body = Schema.decodeUnknownSync(RpcEnvelope)(await response.json())
  expect(body.error).toBeUndefined()
  return body.result
}

const callTool = async (name: string, args: unknown, headers?: Record<string, string>) =>
  Schema.decodeUnknownSync(ToolCallResult)(
    await rpc("tools/call", { name, arguments: args }, headers),
  )

const resultText = (result: typeof ToolCallResult.Type) => result.content[0]!.text

test("the streamable HTTP endpoint lists every tool with the fire-and-ack contract", async () => {
  const listed = Schema.decodeUnknownSync(ToolList)(await rpc("tools/list", {}))

  expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
    "dispatch_agent",
    "enqueue_probe",
    "host_health",
    "job_status",
    "list_recent_jobs",
    "wait_for_agent",
  ])
  for (const name of ["enqueue_probe", "wait_for_agent"]) {
    const write = listed.tools.find((tool) => tool.name === name)
    expect(write?.description).toContain("returns a receipt")
    expect(write?.description).toContain("end your turn")
    expect(write?.description).toContain("none exists")
  }
})

test("an MCP initialize handshake succeeds statelessly", async () => {
  const initialized = Schema.decodeUnknownSync(InitializeResult)(
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "0.0.0" },
    }),
  )

  expect(initialized.serverInfo.name).toBe("workflowd")
})

test("reads work without credentials while enqueue_probe requires the bearer token", async () => {
  const health = await callTool("host_health", {})
  expect(health.isError ?? false).toBe(false)

  const refused = await callTool("enqueue_probe", { host: "host-a" })
  expect(refused.isError).toBe(true)
  expect(resultText(refused)).toContain("unauthorized")
  expect(resultText(refused)).not.toContain("integration-token")

  const wrongToken = await callTool(
    "enqueue_probe",
    { host: "host-a" },
    { authorization: "Bearer wrong-token" },
  )
  expect(wrongToken.isError).toBe(true)
})

test("an authorized enqueue returns a receipt and job_status can read it back", async () => {
  const receipt = await callTool(
    "enqueue_probe",
    { host: "host-a", probe_id: "http-roundtrip" },
    { authorization: "Bearer integration-token" },
  )
  expect(receipt.isError ?? false).toBe(false)
  expect(resultText(receipt)).toContain("remote-probe-http-roundtrip")
  expect(resultText(receipt)).toContain("End your turn now")

  const status = await callTool("job_status", { job_id: "remote-probe-http-roundtrip" })
  expect(JSON.parse(resultText(status))).toMatchObject({
    jobId: "remote-probe-http-roundtrip",
    state: "ready",
  })
})

test("the server exposes a health endpoint and rejects unknown paths", async () => {
  const health = await fetch(`http://127.0.0.1:${started.port}/health`)
  expect(await health.json()).toEqual({ status: "ok" })
  const missing = await fetch(`http://127.0.0.1:${started.port}/nope`)
  expect(missing.status).toBe(404)
})
