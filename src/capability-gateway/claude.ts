import { credentialPatterns } from "./provider-evidence"
import { checkHeaders, RequestRefused } from "./headers"

const forwarded = new Set([
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
  "x-app",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
  "x-stainless-timeout",
])
/**
 * The anthropic-beta values the pinned Claude Code (test/resources/claude-code-version) sends on a messages call, for each
 * model family it knows. test/capability-gateway/claude-pinned.test.ts records them in CI and
 * fails when the pinned client sends a value this list does not hold.
 */
export const claudeBetas: ReadonlySet<string> = new Set([
  "afk-mode-2026-01-31",
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "context-management-2025-06-27",
  "dangerous-tool-use-2026-09-03",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07",
  "mid-conversation-tool-changes-2026-07-01",
  "oauth-2025-04-20",
  "per-turn-control-2026-07-01",
  "prompt-caching-scope-2026-01-05",
  "thinking-token-count-2026-05-13",
])
export interface ClaudeRequest {
  readonly body: Uint8Array<ArrayBuffer>
  readonly headers: Headers
  readonly signal: AbortSignal
  readonly method: "POST"
  readonly redirect: "error"
}
export type ClaudeUpstream = (url: string, input: ClaudeRequest) => Promise<Response>

export async function readRequestBody(request: Request, signal: AbortSignal, limit: number) {
  signal.throwIfAborted()
  if (!request.body) throw new RequestRefused()
  const reader = request.body.getReader()
  let cancelled: Promise<void> | undefined
  const stop = () => {
    cancelled ??= reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", stop, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      const chunk: unknown = item.value
      if (!(chunk instanceof Uint8Array)) throw new RequestRefused()
      size += chunk.length
      if (size > limit) throw new RequestRefused()
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally {
    signal.removeEventListener("abort", stop)
    stop()
    await cancelled
    reader.releaseLock()
  }
}

function withoutCredential(body: ReadableStream<Uint8Array>, patterns: ReadonlyArray<Buffer>) {
  const reader = body.getReader()
  const overlap = Math.max(...patterns.map((pattern) => pattern.length)) - 1
  let pending = Buffer.alloc(0)
  return new ReadableStream<Uint8Array>(
    {
      async pull(output) {
        try {
          while (true) {
            const item = await reader.read()
            if (!item.done) pending = Buffer.concat([pending, item.value])
            if (patterns.some((pattern) => pending.includes(pattern)))
              throw new Error("upstream credential reflection")
            if (item.done) {
              if (pending.length) output.enqueue(pending)
              pending = Buffer.alloc(0)
              output.close()
              return
            }
            if (pending.length > overlap) {
              const end = pending.length - overlap
              output.enqueue(pending.subarray(0, end))
              pending = Buffer.from(pending.subarray(end))
              return
            }
          }
        } catch {
          output.error(new Error("upstream unavailable"))
          await reader.cancel()
        }
      },
      cancel: () => reader.cancel(),
    },
    { highWaterMark: 1 },
  )
}

/** Headers of the client's transport, accepted and not sent on. */
const dropped = new Set([
  "authorization",
  "host",
  "content-length",
  "accept-encoding",
  "anthropic-dangerous-direct-browser-access",
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Native request headers allowed through: bounded, unprivileged, anthropic-beta values of the
 * recorded list only, and the client's session id when it is a UUID.
 */
function claudeHeaders(request: Request) {
  const headers = new Headers()
  checkHeaders(request, (key, value) => {
    const sent = forwarded.has(key) || (key === "x-claude-code-session-id" && uuid.test(value))
    if (sent) headers.set(key, value)
    return sent || dropped.has(key)
  })
  const betas = headers
    .get("anthropic-beta")
    ?.split(",")
    .map((value) => value.trim())
  if (
    !/^application\/json(?:; ?charset=utf-8)?$/i.test(headers.get("content-type") ?? "") ||
    headers.get("anthropic-version") !== "2023-06-01" ||
    !betas?.includes("oauth-2025-04-20") ||
    !betas.every((value) => claudeBetas.has(value))
  )
    throw new RequestRefused()
  return headers
}

/**
 * A JSON number text as its exact decimal value: digits without leading or trailing zeros and a
 * power of ten, or undefined when the text is not a finite JSON number.
 */
function decimalValue(text: string) {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!parts) return undefined
  const fraction = parts[3] ?? ""
  const digits = `${parts[2]}${fraction}`.replace(/^0+/, "")
  const significant = digits.replace(/0+$/, "")
  if (significant === "") return "0"
  const exponent = Number(parts[4] ?? "0") - fraction.length + (digits.length - significant.length)
  return `${parts[1]}${significant}e${exponent}`
}

/**
 * Keeps a parsed number only when `JSON.stringify` gives back a text of the same value as the
 * one the client sent (`1.0` is sent as `1`); a number that the parse would change is refused.
 */
function sameNumber(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
  if (
    typeof value === "number" &&
    (context?.source === undefined ||
      decimalValue(context.source) !== decimalValue(JSON.stringify(value)))
  )
    throw new RequestRefused()
  return value
}

/** The one parse of a request body: the value the checks see and the provider gets. */
function parsedBody(body: Buffer) {
  let data: unknown
  try {
    data = JSON.parse(body.toString("utf8"), sameNumber)
  } catch {
    throw new RequestRefused()
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new RequestRefused()
  return data
}

/** Only this adapter chooses the upstream. Native auth is replaced, never exported or downgraded. */
export async function claudeRequest(
  request: Request,
  path: string,
  model: string,
  credential: () => Promise<string>,
  signal: AbortSignal,
  send: ClaudeUpstream,
) {
  if (
    request.method !== "POST" ||
    ![
      "/v1/messages",
      "/v1/messages?beta=true",
      "/v1/messages/count_tokens",
      "/v1/messages/count_tokens?beta=true",
    ].includes(path)
  )
    throw new RequestRefused()
  const headers = claudeHeaders(request)
  const data = parsedBody(await readRequestBody(request, signal, 1048576))
  if (!("model" in data) || data.model !== model) throw new RequestRefused()
  const access = await credential()
  signal.throwIfAborted()
  headers.set("authorization", `Bearer ${access}`)
  headers.set("accept-encoding", "identity")
  const response = await send(`https://api.anthropic.com${path}`, {
    method: "POST",
    // The JSON text of the value that was checked: a key named twice is sent once, as checked.
    body: Buffer.from(JSON.stringify(data)),
    headers,
    redirect: "error",
    signal,
  })
  return await safeProviderResponse(response, [access])
}

/** Same bounded credential-reflection exclusion for every native protocol. */
export async function safeProviderResponse(response: Response, secrets: ReadonlyArray<string>) {
  const patterns = credentialPatterns(secrets)
  if (
    (response.status >= 300 && response.status < 400) ||
    response.headers.has("content-encoding")
  ) {
    await response.body?.cancel()
    throw new Error("upstream unavailable")
  }
  const outgoing = new Headers({ "cache-control": "no-store" })
  for (const name of ["content-type", "request-id", "retry-after"])
    if (response.headers.has(name)) {
      const value = response.headers.get(name) ?? ""
      if (value.length > 256 || patterns.some((pattern) => Buffer.from(value).includes(pattern)))
        throw new Error("upstream unavailable")
      outgoing.set(name, value)
    }
  return {
    response: new Response(
      response.body === null ? null : withoutCredential(response.body, patterns),
      { status: response.status },
    ),
    headers: outgoing,
  }
}
