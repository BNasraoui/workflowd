import { Schema } from "effect"
import { readRequestBody, safeProviderResponse, type ClaudeUpstream } from "./claude"
import { nativeHeaders } from "./codex"
import type { RetainProviderEvidence } from "./provider-evidence"

const Body = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    stream: Schema.Literal(true),
    reasoning_effort: Schema.String,
    messages: Schema.Array(Schema.Unknown),
  }),
)
const native = new Set([
  "b3",
  "traceparent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
])

/** Explicit configured OpenAI Chat profile. Credentials come only from the host owner. */
export async function opencodeRequest(
  request: Request,
  path: string,
  model: string,
  credential: () => Promise<string>,
  signal: AbortSignal,
  send: ClaudeUpstream,
  _session?: string,
  effort?: string,
  retain?: RetainProviderEvidence,
) {
  if (request.method !== "POST" || path !== "/chat/completions" || effort === undefined)
    throw new Error("request refused")
  const headers = nativeHeaders(request, native)
  const body = await readRequestBody(request, signal, 1048576)
  const decoded = Schema.decodeUnknownResult(Body)(body.toString("utf8"))
  if (
    decoded._tag === "Failure" ||
    decoded.success.model !== model ||
    decoded.success.reasoning_effort !== effort
  )
    throw new Error("request refused")
  const access = await credential()
  if (!access || /[\r\n\0]/.test(access)) throw new Error("upstream unavailable")
  headers.set("authorization", `Bearer ${access}`)
  signal.throwIfAborted()
  const response = await send("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    body,
    headers,
    signal,
    redirect: "error",
  })
  return {
    ...(await safeProviderResponse(response, [access], "openai-chat", retain)),
    selectionObserved: true,
  }
}
