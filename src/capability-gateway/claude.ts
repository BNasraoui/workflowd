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
 * model family it knows. test/capability-gateway/claude-pinned.launcher.test.ts records them in CI and
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
/** Sends a call upstream that may make `reservation` output tokens at most. */
export type ClaudeSend = (
  url: string,
  input: ClaudeRequest,
  reservation: number,
) => Promise<Response>

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
  let end = digits.length
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end--
  const significant = digits.slice(0, end)
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

/**
 * The `max_tokens` of a messages call: a positive integer of at most `cap`. A call that asks more,
 * asks none or asks a value that is not a positive integer is refused.
 */
function askedTokens(data: object, cap: number) {
  const asked: unknown = "max_tokens" in data ? data.max_tokens : undefined
  if (typeof asked !== "number" || !Number.isSafeInteger(asked) || asked < 1 || asked > cap)
    throw new RequestRefused()
  return asked
}

/**
 * Only this adapter chooses the upstream. Native auth is replaced, never exported or downgraded.
 * A messages call asks at most `maxTokens` output tokens and is sent with its `max_tokens` as its
 * reservation; a count of tokens makes none and is sent with none. `usage` gives the usage that
 * the answer reported so far.
 */
export async function claudeRequest(
  request: Request,
  path: string,
  model: string,
  credential: () => Promise<string>,
  signal: AbortSignal,
  send: ClaudeSend,
  maxTokens: number,
) {
  const messages = ["/v1/messages", "/v1/messages?beta=true"].includes(path)
  if (
    request.method !== "POST" ||
    (!messages &&
      !["/v1/messages/count_tokens", "/v1/messages/count_tokens?beta=true"].includes(path))
  )
    throw new RequestRefused()
  const headers = claudeHeaders(request)
  const data = parsedBody(await readRequestBody(request, signal, 1048576))
  if (!("model" in data) || data.model !== model) throw new RequestRefused()
  const reservation = messages ? askedTokens(data, maxTokens) : 0
  const access = await credential()
  signal.throwIfAborted()
  headers.set("authorization", `Bearer ${access}`)
  headers.set("accept-encoding", "identity")
  const response = await send(
    `https://api.anthropic.com${path}`,
    {
      method: "POST",
      // The JSON text of the value that was checked: a key named twice is sent once, as checked.
      body: Buffer.from(JSON.stringify(data)),
      headers,
      redirect: "error",
      signal,
    },
    reservation,
  ).catch((error: unknown) => {
    throw madeNoOutput(error) ? new NoProviderOutput() : error
  })
  // A redirect of the provider comes before any output.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new NoProviderOutput()
  }
  // An error answer of the provider comes before any output: it reports none.
  const answered = response.status >= 200 && response.status < 300
  const meter =
    messages && answered ? usageMeter(response.headers.get("content-type") ?? "") : undefined
  const selected = await safeProviderResponse(response, [access], meter)
  // A count of tokens makes no output; the run is charged its reservation of none.
  const usage = (): ReportedUsage | undefined => {
    if (!messages) return undefined
    return meter === undefined ? noOutput : meter.usage()
  }
  return { ...selected, usage }
}

/**
 * Same bounded credential-reflection exclusion for every native protocol; `meter` reads the
 * bytes of the answer as they pass.
 */
async function safeProviderResponse(
  response: Response,
  secrets: ReadonlyArray<string>,
  meter?: UsageMeter,
) {
  const patterns = credentialPatterns(secrets)
  if (response.headers.has("content-encoding")) {
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
      response.body === null
        ? null
        : withoutCredential(
            meter === undefined ? response.body : metered(response.body, meter),
            patterns,
          ),
      { status: response.status },
    ),
    headers: outgoing,
  }
}

/**
 * The largest token count that the gateway takes from a usage the provider reports: ten times the
 * largest context window of a model. A count above it is no count.
 */
const maxReportedTokens = 10_000_000

/**
 * The token counts that the provider reported for one call. `outputTokens` is undefined until the
 * answer gave its final count: the `message_delta` event of a stream, or the body of an answer
 * that is not a stream.
 */
export interface ReportedUsage {
  readonly inputTokens: number
  readonly outputTokens: number | undefined
  readonly cacheCreationInputTokens: number
  readonly cacheReadInputTokens: number
}
/** The usage of an error answer of the provider: it made no output. */
const noOutput: ReportedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}
/** The most bytes of one event of a stream that the usage reader reads; a longer event is not read. */
const maxUsageEvent = 65536
/** The most bytes of an answer that is not a stream that the usage reader holds. */
const maxUsageAnswer = 4 * 1048576
/** The counts of a usage object that the gateway reads, by their names in the provider's usage. */
const usageCounts = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  cache_creation_input_tokens: "cacheCreationInputTokens",
  cache_read_input_tokens: "cacheReadInputTokens",
} as const
type UsageCount = (typeof usageCounts)[keyof typeof usageCounts]
/** The end of the first event of an event stream, with LF or CRLF line ends. */
function eventEnd(bytes: Buffer) {
  const ends = [
    { at: bytes.indexOf("\n\n"), length: 2 },
    { at: bytes.indexOf("\r\n\r\n"), length: 4 },
  ].filter((end) => end.at >= 0)
  return ends.sort((a, b) => a.at - b.at)[0]
}
const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined

/**
 * Reads the usage of a messages answer as its bytes pass: the `usage` of the `message_start` and
 * `message_delta` events of an event stream, or of the body of a JSON answer. A count is taken
 * only when it is an integer from 0 to `maxReportedTokens`; an input count may also be null, which
 * reports nothing. Any other value, a usage that is not an object, or an answer of another type
 * makes the whole usage of the call unknown.
 */
function usageMeter(contentType: string) {
  const kind = /^text\/event-stream\b/i.test(contentType)
    ? "events"
    : /^application\/json\b/i.test(contentType)
      ? "json"
      : undefined
  const counts = new Map<UsageCount, number>()
  let unknown = kind === undefined
  let final = false
  let pending = Buffer.alloc(0)
  let skipping = false
  const take = (usage: unknown, last: boolean) => {
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
      unknown = true
      return
    }
    for (const [key, name] of Object.entries(usageCounts)) {
      if (!Object.hasOwn(usage, key)) continue
      const value: unknown = Reflect.get(usage, key)
      if (value === null && name !== "outputTokens") continue
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > maxReportedTokens
      ) {
        unknown = true
        return
      }
      counts.set(name, value)
    }
    if (last && Object.hasOwn(usage, "output_tokens")) final = true
  }
  const parsed = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  const event = (bytes: Buffer) => {
    const data = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    const value = parsed(data)
    const type = field(value, "type")
    if (type === "message_start") take(field(field(value, "message"), "usage"), false)
    if (type === "message_delta") take(field(value, "usage"), true)
  }
  return {
    read(chunk: Uint8Array) {
      if (kind === "json") {
        if (!skipping) pending = Buffer.concat([pending, chunk])
        if (pending.length > maxUsageAnswer) {
          skipping = true
          pending = Buffer.alloc(0)
        }
        return
      }
      // In slices of at most the bound, so the reader holds at most twice the bound.
      for (let at = 0; at < chunk.length; at += maxUsageEvent) {
        pending = Buffer.concat([pending, chunk.subarray(at, at + maxUsageEvent)])
        for (let end = eventEnd(pending); end !== undefined; end = eventEnd(pending)) {
          if (!skipping && end.at <= maxUsageEvent) event(pending.subarray(0, end.at))
          skipping = false
          pending = pending.subarray(end.at + end.length)
        }
        // An event longer than the bound is passed on unread; its end is still found.
        if (pending.length > maxUsageEvent) {
          skipping = true
          pending = pending.subarray(pending.length - 3)
        }
      }
    },
    end() {
      if (kind === "json" && !skipping) take(field(parsed(pending.toString("utf8")), "usage"), true)
      pending = Buffer.alloc(0)
    },
    usage(): ReportedUsage | undefined {
      if (unknown) return undefined
      return {
        inputTokens: counts.get("inputTokens") ?? 0,
        outputTokens: final ? counts.get("outputTokens") : undefined,
        cacheCreationInputTokens: counts.get("cacheCreationInputTokens") ?? 0,
        cacheReadInputTokens: counts.get("cacheReadInputTokens") ?? 0,
      }
    },
  }
}
type UsageMeter = ReturnType<typeof usageMeter>

/** `body` unchanged, each chunk read by `meter`, which learns the end of the answer. */
function metered(body: ReadableStream<Uint8Array>, meter: UsageMeter) {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(output) {
        const item = await reader.read()
        if (item.done) {
          meter.end()
          output.close()
          return
        }
        meter.read(item.value)
        output.enqueue(item.value)
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 1 },
  )
}

/**
 * Whether a failure of the upstream fetch shows that the provider made no output for the call.
 * Bun's fetch fails with `ConnectionRefused` when the connection never opened: the connect was
 * refused, the name did not resolve or the TLS handshake failed, each before a byte of the request
 * was sent. It fails with `UnexpectedRedirect` on a 3xx answer, which `redirect: "error"` refuses.
 * Each other failure can come after the request reached the provider: Bun's fetch gives
 * `ECONNRESET` both for a connection closed before the provider read the request and for one
 * closed after it, and an abort or a failed certificate check is charged as one that the provider
 * can have answered.
 */
function madeNoOutput(error: unknown) {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined
  return code === "ConnectionRefused" || code === "UnexpectedRedirect"
}

/** A model call that ended before the provider could make output; it is charged none. */
export class NoProviderOutput extends Error {
  readonly _tag = "NoProviderOutput"
  readonly usage = noOutput
  constructor() {
    super("upstream unavailable")
  }
}

/**
 * The seconds that a model call held back by its run's open reservations waits before it asks
 * again. A reservation lives as long as the stream of its model call, which takes seconds for a
 * short answer and minutes for a long one; five seconds keeps a client's quick first retries from
 * finding the same streams open, and stays far below the minute above which the pinned Claude
 * Code does not retry a 429.
 */
const heldRetrySeconds = 5

/**
 * A model call that the run's budget holds only once the run's open reservations settle; the
 * gateway answers it with `budgetHeld`.
 */
export class RunBudgetHeld extends Error {
  readonly _tag = "RunBudgetHeld"
  constructor() {
    super("run budget held by open calls")
  }
}

/** The answer to a call that open reservations hold back, in the provider's rate limit form. */
export const budgetHeld = () =>
  new Response(
    JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "workflowd run budget held by open calls" },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": String(heldRetrySeconds),
      },
    },
  )

/** A model call of a run whose budget is spent; the gateway answers it with `budgetSpent`. */
export class RunBudgetSpent extends Error {
  readonly _tag = "RunBudgetSpent"
  constructor() {
    super("run budget spent")
  }
}

/** The answer to a model call of a run whose budget is spent, in the provider's error form. */
export const budgetSpent = () =>
  new Response(
    JSON.stringify({
      type: "error",
      error: { type: "permission_error", message: "workflowd run budget spent" },
    }),
    { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  )
