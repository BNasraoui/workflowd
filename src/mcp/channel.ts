import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { canonicalJson } from "../kernel/session-store-support"
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server"
import { TOOL_DEFINITIONS } from "./tool-definitions"
import type { ToolResult } from "./tools"

export const CHANNEL_NOTIFICATION = "notifications/claude/channel"
export const DEFAULT_CHANNEL_POLL_MS = 10_000

export type ChannelOptions = {
  readonly mcpUrl: string
  readonly token: string
  readonly pollIntervalMs: number
}

const LIVE_SESSION_FIELDS = [
  "parent_session_id",
  "parent_kind",
  "parent_directory",
  "parent_host",
  "resume_prompt",
] as const

const CHANNEL_RECEIPT_LINE =
  "This session is connected to the workflowd channel: the result arrives as a channel " +
  "event; end your turn."

const INSTRUCTIONS =
  "workflowd children you dispatch through this server report back here. Each child's " +
  'terminal mailbox message arrives as <channel source="workflowd" run_id=... mailbox_id=... ' +
  "status=...> holding the message JSON. After dispatch_agent returns, end your turn; do not " +
  "poll read_agent_mailbox and do not pass parent_* or resume_prompt."

const ToolCallEnvelope = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      structuredContent: Schema.optional(Schema.Record(Schema.String, JsonValueSchema)),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
})
const DispatchReceipt = Schema.Struct({ run_id: Schema.String, mailbox_id: Schema.String })
const MailboxMessages = Schema.Struct({
  messages: Schema.Array(Schema.Record(Schema.String, JsonValueSchema)),
})

const textResult = (text: string, isError = true): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
})

const refusal = (reason: string, detail: string): ToolResult => ({
  ...textResult(`dispatch_agent was refused: ${detail}`),
  structuredContent: { status: "refused", reason, detail },
})

const liveSessionField = (args: unknown) =>
  typeof args === "object" && args !== null
    ? LIVE_SESSION_FIELDS.find((field) => field in args)
    : undefined

/**
 * Per-session stdio MCP server for a live Claude Code coordinator. It serves
 * the shared workflowd tools by forwarding each call to the HTTP MCP server,
 * and, for children it dispatched, polls their caller mailbox and pushes the
 * terminal message into the open session as one claude/channel event. Watches
 * live only in this process: if it exits, the mailbox row stays readable.
 */
export function createChannelMcp(options: ChannelOptions) {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions: INSTRUCTIONS,
    },
  )
  const watched = new Map<string, string>()
  const settled = new Set<string>()
  const polling = new Set<string>()
  let closed = false

  const forward = async (name: string, args: unknown): Promise<ToolResult> => {
    const response = await fetch(options.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args ?? {} },
      }),
    })
    if (!response.ok) return textResult(`workflowd MCP server returned HTTP ${response.status}`)
    const envelope = Schema.decodeUnknownOption(ToolCallEnvelope)(await response.json())
    if (envelope._tag === "None" || envelope.value.result === undefined) {
      return textResult("workflowd MCP server returned an unrecognized response")
    }
    const { content, structuredContent, isError } = envelope.value.result
    return {
      content: content.map((part) => ({ ...part })),
      ...(structuredContent === undefined ? {} : { structuredContent: { ...structuredContent } }),
      ...(isError === undefined ? {} : { isError }),
    }
  }

  const emit = async (mailboxId: string, runId: string, message: Record<string, JsonValue>) => {
    const status = message.status
    await server.notification({
      method: CHANNEL_NOTIFICATION,
      params: {
        content: canonicalJson(message),
        meta: {
          run_id: runId,
          mailbox_id: mailboxId,
          status: typeof status === "string" ? status : "unknown",
        },
      },
    })
  }

  const poll = async (mailboxId: string, runId: string) => {
    if (polling.has(mailboxId)) return
    polling.add(mailboxId)
    try {
      const result = await forward("read_agent_mailbox", { mailbox_id: mailboxId })
      if (result.isError === true || closed || settled.has(mailboxId)) return
      const mailbox = Schema.decodeUnknownOption(MailboxMessages)(result.structuredContent)
      const message = mailbox._tag === "Some" ? mailbox.value.messages[0] : undefined
      if (message === undefined) return
      settled.add(mailboxId)
      watched.delete(mailboxId)
      await emit(mailboxId, runId, message)
    } catch {
      // Transport errors leave the watch in place; the next tick retries.
    } finally {
      polling.delete(mailboxId)
    }
  }

  const pollAll = () => Promise.all([...watched].map(([mailbox, run]) => poll(mailbox, run)))
  const timer = setInterval(() => void pollAll(), options.pollIntervalMs)
  timer.unref()

  const dispatch = async (args: unknown): Promise<ToolResult> => {
    const field = liveSessionField(args)
    if (field !== undefined) {
      return refusal(
        "live_session_parent",
        `${field} is not accepted through the workflowd channel: this session is live and ` +
          "must not be resumed. Dispatch without parent_* and resume_prompt; the result " +
          "arrives here as a channel event.",
      )
    }
    const result = await forward("dispatch_agent", args)
    const receipt = Schema.decodeUnknownOption(DispatchReceipt)(result.structuredContent)
    if (result.isError === true || receipt._tag === "None") return result
    const { mailbox_id: mailboxId, run_id: runId } = receipt.value
    if (!settled.has(mailboxId)) watched.set(mailboxId, runId)
    return {
      ...result,
      content: [...result.content, { type: "text", text: CHANNEL_RECEIPT_LINE }],
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      return call.params.name === "dispatch_agent"
        ? await dispatch(call.params.arguments)
        : await forward(call.params.name, call.params.arguments)
    } catch {
      return textResult("tool call failed: workflowd MCP server unreachable")
    }
  })

  return {
    server,
    close: async () => {
      closed = true
      clearInterval(timer)
      watched.clear()
      await server.close()
    },
  }
}
