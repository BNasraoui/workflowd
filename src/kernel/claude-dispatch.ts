import { fileURLToPath } from "node:url"
import { Context, Effect, Schema } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import {
  makeCodexCli,
  type CodexCliOptions,
  type CodexCliPort,
  type CodexExecEvent,
  type CodexPreflightError,
} from "./codex-session"

export const ClaudeDispatchCli = Context.Service<CodexCliPort>("workflowd/kernel/ClaudeDispatchCli")

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
const contentText = (value: unknown): string => {
  if (!Array.isArray(value)) return ""
  return value
    .filter(record)
    .map((block) =>
      typeof block.text === "string"
        ? block.text
        : block.type === "tool_use"
          ? `[tool_use:${String(block.name)}]`
          : "",
    )
    .join("")
}

/** Normalize the real `claude -p --output-format stream-json` wire protocol. */
export const parseClaudeDispatchEvent = (line: string): CodexExecEvent => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { type: "other" }
  }
  if (!record(value)) return { type: "other" }
  if (value.type === "system" && value.subtype === "init" && typeof value.session_id === "string")
    return { type: "thread.started", threadId: value.session_id }
  if (value.parent_tool_use_id != null) return { type: "other" }
  if (value.type === "result") {
    if (value.is_error === true)
      return {
        type: "turn.failed",
        message: Array.isArray(value.errors)
          ? value.errors.map(String).join("; ")
          : String(value.result ?? value.subtype),
      }
    return {
      type: "turn.completed",
      outputTokens:
        record(value.usage) && typeof value.usage.output_tokens === "number"
          ? value.usage.output_tokens
          : null,
    }
  }
  if (value.type === "assistant" && record(value.message)) {
    const text = contentText(value.message.content)
    if (typeof value.error === "string")
      return { type: "error", message: `${value.error}: ${text}` }
    return text === "" ? { type: "other" } : { type: "agent_message", text }
  }
  if (value.type === "stream_event" && record(value.event)) {
    const event = value.event
    if (
      event.type === "content_block_delta" &&
      record(event.delta) &&
      event.delta.type === "text_delta" &&
      typeof event.delta.text === "string" &&
      event.delta.text !== ""
    )
      return { type: "agent_message", text: event.delta.text }
    if (
      event.type === "content_block_start" &&
      record(event.content_block) &&
      event.content_block.type === "tool_use"
    )
      return { type: "agent_message", text: `[tool_use:${String(event.content_block.name)}]` }
  }
  return { type: "other" }
}

const AuthStatus = Schema.Struct({ loggedIn: Schema.Boolean })

export const makeClaudeDispatchCli = (options: Omit<CodexCliOptions, "driver">) =>
  makeCodexCli({
    ...options,
    unitPrefix: options.unitPrefix ?? "workflowd-claude-",
    driver: {
      name: "claude",
      workerPath: fileURLToPath(new URL("./claude-worker.ts", import.meta.url)),
      parseEvent: parseClaudeDispatchEvent,
      preflight: Effect.gen(function* () {
        yield* runWorkspaceCommand("check claude cli", [options.binary, "--version"]).pipe(
          Effect.mapError((cause): CodexPreflightError => ({
            kind: "cli_unusable",
            detail: `Claude CLI version check failed: ${String(cause.cause)}`,
          })),
        )
        const status = yield* runWorkspaceCommand("check claude auth", [
          options.binary,
          "auth",
          "status",
        ]).pipe(
          Effect.flatMap((stdout) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(AuthStatus))(stdout),
          ),
          Effect.mapError((): CodexPreflightError => ({
            kind: "not_authenticated",
            detail:
              "Claude CLI authentication check failed; run claude auth login on the daemon host",
          })),
        )
        if (!status.loggedIn)
          return yield* Effect.fail({
            kind: "not_authenticated" as const,
            detail: "Claude CLI is not logged in; run claude auth login on the daemon host",
          })
      }),
    },
  })
