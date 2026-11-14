import { Schema } from "effect"
import { readRequestBody, safeProviderResponse, type ClaudeUpstream } from "./claude"
import type { RetainProviderEvidence } from "./provider-evidence"

const Credential = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
    accountId: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/)),
  }),
)
const Body = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    stream: Schema.Literal(true),
    store: Schema.Literal(false),
    reasoning: Schema.Struct({ effort: Schema.String }),
    tools: Schema.optionalKey(
      Schema.Array(Schema.Struct({ type: Schema.Literals(["function", "custom", "namespace"]) })),
    ),
    background: Schema.optionalKey(Schema.Literal(false)),
  }),
)

/** Native identity headers are bounded input, never account/run authority. */
export function nativeHeaders(request: Request, native: ReadonlySet<string>) {
  let size = 0
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    size += key.length + value.length
    if (
      size > 8192 ||
      value.length > 2048 ||
      /[\r\n\0]/.test(value) ||
      (![
        "authorization",
        "host",
        "content-length",
        "content-type",
        "accept",
        "accept-encoding",
        "user-agent",
      ].includes(key) &&
        !native.has(key))
    )
      throw new Error("request refused")
    if (["content-type", "accept", "user-agent"].includes(key)) headers.set(key, value)
  }
  if (
    (request.headers.get("host") ?? "capability.invalid") !== "capability.invalid" ||
    !/^application\/json(?:; ?charset=utf-8)?$/i.test(headers.get("content-type") ?? "")
  )
    throw new Error("request refused")
  headers.set("accept-encoding", "identity")
  return headers
}

const native = new Set([
  "originator",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-turn-metadata",
  "x-codex-window-id",
  "x-codex-beta-features",
  "chatgpt-account-id",
])

/** 0.159.1 ChatGPT Responses over explicit HTTP. No API-billing or WS fallback. */
export async function codexRequest(
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
  if (request.method !== "POST" || path !== "/responses" || effort === undefined)
    throw new Error("request refused")
  const headers = nativeHeaders(request, native)
  const body = await readRequestBody(request, signal, 1048576)
  const decoded = Schema.decodeUnknownResult(Body)(body.toString("utf8"))
  if (
    decoded._tag === "Failure" ||
    decoded.success.model !== model ||
    decoded.success.reasoning.effort !== effort
  )
    throw new Error("request refused")
  const access = Schema.decodeUnknownSync(Credential)(await credential())
  headers.set("authorization", `Bearer ${access.accessToken}`)
  headers.set("chatgpt-account-id", access.accountId)
  headers.set("originator", "codex_exec")
  signal.throwIfAborted()
  const response = await send("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    body,
    headers,
    signal,
    redirect: "error",
  })
  return {
    ...(await safeProviderResponse(
      response,
      [access.accessToken, access.accountId],
      "codex-chatgpt",
      retain,
    )),
    selectionObserved: true,
  }
}
