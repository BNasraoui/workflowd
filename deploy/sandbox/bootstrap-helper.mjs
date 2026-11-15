import { maxProofLength } from "./capability-limits.mjs"
/** The gateway's origin: HTTPS only, with no credentials, path, query or fragment. */
export function gatewayOrigin(value) {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("gateway refused")
  return url.origin
}

async function boundedJson(response, limit) {
  let text = ""
  for await (const bytes of response.body ?? []) {
    text += Buffer.from(bytes).toString("utf8")
    if (text.length > limit) throw new Error("gateway answer refused")
  }
  return JSON.parse(text)
}

const pause = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

/**
 * Network failures that can clear by a wait: a refused connection, a reset, a timeout, and a
 * name that does not resolve yet (the first seconds after the runner joins the tailnet), by the
 * codes of Node's fetch and of Bun's.
 */
const passing = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "ConnectionClosed",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
])

/** The code of a certificate that the runner does not trust: no wait can clear it. */
function untrustedCertificate(error) {
  const code = error?.cause?.code ?? error?.code
  return typeof code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|ALTNAME/.test(code)
    ? new Error(`gateway certificate not trusted (${code})`)
    : undefined
}

const passes = (error) =>
  error?.name === "TimeoutError" || passing.has(error?.cause?.code ?? error?.code)

/**
 * Opens the run's gateway session: a challenge for the lease, an OIDC proof for that challenge,
 * and the session post. A challenge that is not ready (503, a refused connection, a reset, a
 * timeout or a name that does not resolve yet) uses no attempt: the helper waits, with backoff up
 * to 10 seconds, for at most `wait` milliseconds in all, since the daemon may record the Actions
 * run after the runner first asks.
 * Any other failure of the challenge ends the exchange at once: a refused challenge (a lease id
 * that is not well formed), another status, and a certificate that the runner does not trust,
 * which no wait can clear. An answer can be lost after the gateway sent it, so a lost or refused
 * session costs a new proof, at most `attempts` times.
 */
export async function openSession({
  gateway,
  leaseId,
  issue,
  send = fetch,
  attempts = 5,
  backoff = (attempt) => Math.min(4000, 250 * 2 ** attempt),
  wait = 180000,
  waitBackoff = (waited) => Math.min(10000, 500 * 2 ** waited),
  clock = Date.now,
  sleep = pause,
  signal,
}) {
  const origin = gatewayOrigin(gateway)
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(leaseId ?? "")) throw new Error("lease refused")
  const started = clock()
  let waited = 0
  const bounded = () => AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
  const challenge = async () => {
    let response
    try {
      response = await send(new URL(`/capabilities/v1/challenge?lease=${leaseId}`, origin), {
        redirect: "error",
        signal: bounded(),
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (passes(error)) return undefined
      throw untrustedCertificate(error) ?? new Error("gateway unavailable")
    }
    if (response.status === 503) return undefined
    if (response.status === 403) throw new Error("lease refused")
    if (response.status !== 200) throw new Error("gateway unavailable")
    return await boundedJson(response, 4096)
  }
  for (let attempt = 0; attempt < attempts; ) {
    const issued = await challenge()
    if (issued === undefined) {
      const left = started + wait - clock()
      if (left <= 0) break
      await sleep(Math.min(left, waitBackoff(waited++)), signal)
      continue
    }
    if (!/^[a-f0-9]{64}$/.test(issued?.channel) || !/^[a-f0-9]{64}$/.test(issued?.nonce))
      throw new Error("challenge refused")
    attempt++
    const token = await issue(`workflowd:${issued.channel}:${issued.nonce}`, bounded())
    if (typeof token !== "string" || token.length > maxProofLength) throw new Error("job identity refused")
    try {
      const response = await send(new URL("/capabilities/v1/session", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        redirect: "error",
        signal: bounded(),
      })
      if (response.status === 200) {
        const grant = await boundedJson(response, 4096)
        if (
          /^[A-Za-z0-9_-]{43}$/.test(grant.token) &&
          [grant.expiresAt, grant.renewAt, grant.deadline].every(Number.isSafeInteger) &&
          grant.expiresAt <= grant.deadline
        )
          return {
            token: grant.token,
            expiresAt: grant.expiresAt,
            renewAt: grant.renewAt,
            deadline: grant.deadline,
          }
      }
    } catch (error) {
      // The answer is lost; the next attempt proves the runner again. An untrusted
      // certificate does not change by a new proof.
      const untrusted = untrustedCertificate(error)
      if (untrusted) throw untrusted
    }
    if (attempt < attempts) await sleep(backoff(attempt), signal)
  }
  throw new Error("gateway session unavailable")
}

/**
 * Transfer the runner's OIDC request authority into helper-local custody. It issues at most
 * `limit` proofs and is cleared after the last one, or on `clear()`.
 */
export function takeJobIdentity(environment, send = fetch, limit = 5) {
  let requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  let requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL
  delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  delete environment.ACTIONS_ID_TOKEN_REQUEST_URL
  let issued = 0
  const clear = () => {
    requestToken = undefined
    requestUrl = undefined
  }
  const issue = async (audience, signal) => {
    try {
      if (issued >= limit || !requestToken || !requestUrl)
        throw new Error("job identity unavailable")
      issued++
      const url = new URL(requestUrl)
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".actions.githubusercontent.com") ||
        url.username ||
        url.password
      )
        throw new Error("job identity unavailable")
      url.searchParams.set("audience", audience)
      const response = await send(url, {
        headers: { authorization: `Bearer ${requestToken}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      })
      if (!response.ok || !response.body) throw new Error("job identity unavailable")
      let text = ""
      for await (const bytes of response.body) {
        text += Buffer.from(bytes).toString("utf8")
        if (text.length > 20000) throw new Error("job identity unavailable")
      }
      return JSON.parse(text).value
    } catch (error) {
      clear()
      throw error
    } finally {
      if (issued >= limit) clear()
    }
  }
  return Object.assign(issue, { clear })
}
