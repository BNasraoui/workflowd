import { maxProofLength, providerIdPattern } from "./capability-limits.mjs"
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
 * Network failures that can clear by a wait: a refused connection, a reset, a timeout, a name
 * that does not resolve yet, and a route that is not up yet (the first seconds after the runner
 * joins the tailnet), by the codes of Node's fetch and of Bun's. Bun 1.3 reports a name that does
 * not resolve as ConnectionRefused or FailedToOpenSocket.
 */
const passing = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ConnectionRefused",
  "FailedToOpenSocket",
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
 * timeout, a name that does not resolve yet or a route that is not up yet) uses no attempt: the
 * helper waits, with backoff up to 10 seconds, for at most `wait` milliseconds in all, since the
 * daemon may record the Actions run after the runner first asks.
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
  const bounded = () => AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
  const waiting = { started: clock(), waited: 0, wait, waitBackoff, clock, sleep, signal }
  for (let attempt = 0; attempt < attempts; ) {
    const issued = await readyChallenge(
      () => askChallenge(send, origin, leaseId, bounded, signal),
      waiting,
    )
    if (issued === undefined) break
    if (!/^[a-f0-9]{64}$/.test(issued?.channel) || !/^[a-f0-9]{64}$/.test(issued?.nonce))
      throw new Error("challenge refused")
    attempt++
    const token = await issue(`workflowd:${issued.channel}:${issued.nonce}`, bounded())
    if (typeof token !== "string" || token.length > maxProofLength)
      throw new Error("job identity refused")
    const grant = await postSession(send, origin, token, bounded)
    if (grant) return grant
    if (attempt < attempts) await sleep(backoff(attempt), signal)
  }
  throw new Error("gateway session unavailable")
}

/** One challenge for the lease: its JSON, or undefined when the gateway has none ready. */
async function askChallenge(send, origin, leaseId, bounded, signal) {
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

/**
 * Asks until a challenge is ready, with the wait backoff between asks; undefined once `wait`
 * milliseconds have passed since the first ask of the exchange.
 */
async function readyChallenge(ask, waiting) {
  for (;;) {
    const issued = await ask()
    if (issued !== undefined) return issued
    const left = waiting.started + waiting.wait - waiting.clock()
    if (left <= 0) return undefined
    await waiting.sleep(Math.min(left, waiting.waitBackoff(waiting.waited++)), waiting.signal)
  }
}

/**
 * Posts one proof: the session's grant, or undefined when the answer is refused or lost. An
 * untrusted certificate does not change by a new proof, so it ends the exchange.
 */
async function postSession(send, origin, token, bounded) {
  try {
    const response = await send(new URL("/capabilities/v1/session", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      redirect: "error",
      signal: bounded(),
    })
    if (response.status !== 200) return undefined
    const grant = await boundedJson(response, 4096)
    if (
      /^[A-Za-z0-9_-]{43}$/.test(grant.token) &&
      [grant.expiresAt, grant.renewAt, grant.deadline].every(Number.isSafeInteger) &&
      grant.expiresAt <= grant.deadline &&
      typeof grant.providerId === "string" &&
      providerIdPattern.test(grant.providerId)
    )
      return {
        token: grant.token,
        expiresAt: grant.expiresAt,
        renewAt: grant.renewAt,
        deadline: grant.deadline,
        providerId: grant.providerId,
      }
    return undefined
  } catch (error) {
    const untrusted = untrustedCertificate(error)
    if (untrusted) throw untrusted
    return undefined
  }
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
