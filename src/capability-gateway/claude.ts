import {
  credentialPatterns,
  providerResponseEvidence,
  type ProviderProtocol,
  type RetainProviderEvidence,
} from "./provider-evidence"

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
  if (!request.body) throw new Error("request refused")
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
      if (!(chunk instanceof Uint8Array)) throw new Error("request refused")
      size += chunk.length
      if (size > limit) throw new Error("request refused")
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

/** Native request headers allowed through: bounded, unprivileged, exact session only. */
function claudeHeaders(request: Request, nativeSession?: string) {
  let headerBytes = 0
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    headerBytes += key.length + value.length
    if (
      headerBytes > 8192 ||
      value.length > 2048 ||
      /[\r\n\0]/.test(value) ||
      (!forwarded.has(key) &&
        key !== "authorization" &&
        key !== "host" &&
        !(
          key === "x-claude-code-session-id" &&
          nativeSession !== undefined &&
          value === nativeSession
        ) &&
        key !== "content-length" &&
        key !== "accept-encoding")
    )
      throw new Error("request refused")
    if (forwarded.has(key)) headers.set(key, value)
  }
  if (
    (request.headers.get("host") ?? "capability.invalid") !== "capability.invalid" ||
    !/^application\/json(?:; ?charset=utf-8)?$/i.test(headers.get("content-type") ?? "") ||
    headers.get("anthropic-version") !== "2023-06-01" ||
    !headers
      .get("anthropic-beta")
      ?.split(",")
      .map((value) => value.trim())
      .includes("oauth-2025-04-20")
  )
    throw new Error("request refused")
  return headers
}

const effortObserved = (data: object, nativeEffort?: string) =>
  nativeEffort !== undefined &&
  "output_config" in data &&
  typeof data.output_config === "object" &&
  data.output_config !== null &&
  "effort" in data.output_config &&
  data.output_config.effort === nativeEffort

/** Only this adapter chooses the upstream. Native auth is replaced, never exported or downgraded. */
export async function claudeRequest(
  request: Request,
  path: string,
  model: string,
  credential: () => Promise<string>,
  signal: AbortSignal,
  send: ClaudeUpstream,
  nativeSession?: string,
  nativeEffort?: string,
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
    throw new Error("request refused")
  const headers = claudeHeaders(request, nativeSession)
  const body = await readRequestBody(request, signal, 1048576)
  const data: unknown = JSON.parse(body.toString("utf8"))
  if (typeof data !== "object" || data === null || !("model" in data) || data.model !== model)
    throw new Error("request refused")
  const selectionObserved = effortObserved(data, nativeEffort)
  const access = await credential()
  signal.throwIfAborted()
  headers.set("authorization", `Bearer ${access}`)
  if (nativeSession !== undefined) headers.set("x-claude-code-session-id", nativeSession)
  headers.set("accept-encoding", "identity")
  const response = await send(`https://api.anthropic.com${path}`, {
    method: "POST",
    body,
    headers,
    redirect: "error",
    signal,
  })
  return { ...(await safeProviderResponse(response, [access])), selectionObserved }
}

/** Same bounded credential-reflection exclusion for every native protocol. */
export async function safeProviderResponse(
  response: Response,
  secrets: ReadonlyArray<string>,
  protocol?: ProviderProtocol,
  retain?: RetainProviderEvidence,
) {
  const patterns = credentialPatterns(secrets)
  const evidence =
    protocol === undefined ? undefined : providerResponseEvidence(response, protocol, patterns)
  if (retain && evidence) {
    try {
      await retain(evidence)
    } catch {
      await response.body?.cancel()
      throw new Error("upstream unavailable")
    }
  }
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
