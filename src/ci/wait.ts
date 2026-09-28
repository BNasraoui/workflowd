import { Schema } from "effect"
import { CiState } from "./store"
import type { CiTarget } from "./event"

export async function waitCi(
  options: CiTarget & {
    readonly baseUrl: string
    readonly token: string
    readonly timeoutMs: number
  },
  io: {
    readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
    readonly heartbeat: (line: string) => void
  },
): Promise<CiState> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 86400000
  )
    throw new Error("CI timeout must be 1..86400000ms")
  const url = new URL(options.baseUrl)
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("CI endpoint requires HTTPS or loopback HTTP")
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(new Error("CI wait timeout")), options.timeoutMs)
  const heartbeat = setInterval(
    () => io.heartbeat(`waiting for CI ${options.repository}@${options.sha}`),
    60000,
  )
  const query = new URLSearchParams({ repo: options.repository, sha: options.sha })
  const request = async (path: string): Promise<unknown> => {
    const response = await io.fetch(new URL(path, url).toString(), {
      headers: { authorization: `Bearer ${options.token}` },
      signal: abort.signal,
      redirect: "error",
    })
    if (!response.ok) throw new Error(`CI wait HTTP ${response.status}`)
    return response.json()
  }
  const validate = (state: CiState) => {
    if (state.repository !== options.repository || state.sha !== options.sha)
      throw new Error("CI response target mismatch")
    return state
  }
  try {
    let state = validate(
      Schema.decodeUnknownSync(CiState)(await request(`/ci/state?${query.toString()}`)),
    )
    while (state.conclusion === "pending") {
      query.set("after", String(state.sequence))
      const events = Schema.decodeUnknownSync(Schema.Array(CiState))(
        await request(`/ci/events?${query.toString()}`),
      )
      for (const event of events) {
        validate(event)
        if (event.sequence > state.sequence) state = event
      }
    }
    return state
  } finally {
    clearInterval(heartbeat)
    clearTimeout(deadline)
    abort.abort()
  }
}
