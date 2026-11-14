import { createPublicKey, verify } from "node:crypto"
import { Schema } from "effect"

const githubIssuer = "https://token.actions.githubusercontent.com"
const Header = Schema.Struct({
  alg: Schema.Literal("RS256"),
  typ: Schema.Literal("JWT"),
  kid: Schema.NonEmptyString,
})
const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.NonEmptyString,
  iat: Schema.Int,
  nbf: Schema.Int,
  exp: Schema.Int,
  repository: Schema.String,
  repository_id: Schema.String,
  repository_owner_id: Schema.String,
  repository_owner: Schema.String,
  actor_id: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  workflow_ref: Schema.String,
  workflow_sha: Schema.String,
  job_workflow_ref: Schema.String,
  job_workflow_sha: Schema.String,
  run_id: Schema.String,
  run_attempt: Schema.String,
  event_name: Schema.String,
  runner_environment: Schema.String,
})
const Keys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("RSA"),
      kid: Schema.NonEmptyString,
      n: Schema.String,
      e: Schema.String,
      alg: Schema.optionalKey(Schema.Literal("RS256")),
      use: Schema.optionalKey(Schema.Literal("sig")),
    }),
  ),
})

export interface JobProofContext {
  readonly audience: string
  readonly repository: string
  readonly repositoryId: number
  readonly ownerId: number
  readonly actorId: number
  readonly ref: string
  readonly workflowSha: string
  readonly toolingSha: string
  readonly workflowRef: string
  readonly jobWorkflowRef: string
  readonly runId: number
  readonly attempt: number
}

/** Pure verification boundary; key acquisition and durable single-use consumption belong to custody. */
export function verifyJobProof(
  token: string,
  expected: JobProofContext,
  jwks: unknown,
  now: number,
) {
  try {
    if (token.length > 16384) throw new Error()
    const parts = token.split(".")
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error()
    const [headerPart = "", payloadPart = "", signature = ""] = parts
    const decode = (part: string): unknown =>
      JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    const header = Schema.decodeUnknownSync(Header, { onExcessProperty: "error" })(
      decode(headerPart),
    )
    const keys = Schema.decodeUnknownSync(Keys)(jwks).keys
    const selected = keys.filter((key) => key.kid === header.kid)
    if (keys.length > 32 || selected.length !== 1 || !selected[0]) throw new Error()
    const key = createPublicKey({ key: selected[0], format: "jwk" })
    if (
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        key,
        Buffer.from(signature, "base64url"),
      )
    )
      throw new Error()
    const claims = Schema.decodeUnknownSync(Claims)(decode(payloadPart))
    const [owner, name] = expected.repository.split("/")
    const exact = {
      iss: githubIssuer,
      aud: expected.audience,
      sub: `repo:${owner}@${expected.ownerId}/${name}@${expected.repositoryId}:ref:${expected.ref}`,
      repository: expected.repository,
      repository_id: String(expected.repositoryId),
      repository_owner: owner,
      repository_owner_id: String(expected.ownerId),
      actor_id: String(expected.actorId),
      ref: expected.ref,
      sha: expected.workflowSha,
      workflow_ref: expected.workflowRef,
      workflow_sha: expected.workflowSha,
      job_workflow_ref: expected.jobWorkflowRef,
      job_workflow_sha: expected.toolingSha,
      run_id: String(expected.runId),
      run_attempt: String(expected.attempt),
      event_name: "push",
      runner_environment: "github-hosted",
    }
    if (
      Object.entries(exact).some(([key, value]) => Reflect.get(claims, key) !== value) ||
      claims.nbf * 1000 > now ||
      claims.iat * 1000 > now ||
      claims.exp * 1000 <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 600 ||
      claims.jti.length > 256
    )
      throw new Error()
    return { jti: claims.jti, expiresAt: claims.exp * 1000 }
  } catch {
    // Never retain a JWT, key material, or a decoded claim inside diagnostics.
    throw new Error("job proof refused")
  }
}

/** Fixed production key origin; redirects and token-selected key URLs cannot select trust. */
export async function githubJobKeys(signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${githubIssuer}/.well-known/jwks`, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  if (!response.ok || !response.body) throw new Error("job keys unavailable")
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) throw new Error("job keys unavailable")
    size += chunk.length
    if (size > 65536) throw new Error("job keys unavailable")
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  return value
}

const PeerMap = Schema.Struct({
  Peer: Schema.Record(
    Schema.String,
    Schema.Struct({
      ID: Schema.String,
      HostName: Schema.String,
      Online: Schema.Boolean,
      TailscaleIPs: Schema.Array(Schema.String),
      Tags: Schema.optionalKey(Schema.Array(Schema.String)),
      sshHostKeys: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
})

/** Hostname/tag narrow discovery only. The caller must still verify a fresh signed job challenge. */
export function discoverJobPeer(status: unknown, runId: number, attempt: number) {
  try {
    const peers = Object.values(Schema.decodeUnknownSync(PeerMap)(status).Peer).filter(
      (peer) => peer.HostName === `lease-${runId}-${attempt}`,
    )
    if (!peers.length) return null
    const peer = peers[0]
    if (
      peers.length !== 1 ||
      !peer ||
      !peer.Online ||
      !peer.Tags?.includes("tag:agent-runner") ||
      !peer.sshHostKeys?.length ||
      peer.sshHostKeys.length > 8 ||
      peer.sshHostKeys.some(
        (key) => !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]{20,2048}$/.test(key),
      )
    )
      throw new Error()
    const address = peer.TailscaleIPs.find((ip) => {
      const parts = ip.split(".").map(Number)
      return (
        /^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(ip) &&
        parts[1] !== undefined &&
        parts[1] >= 64 &&
        parts[1] <= 127 &&
        parts.every((part) => part <= 255)
      )
    })
    if (!address) throw new Error()
    return { peerId: peer.ID, address, keys: peer.sshHostKeys }
  } catch {
    throw new Error("job peer refused")
  }
}

/** One bounded private control exchange. All authority is decided before sending a grant. */
export async function exchangeJobProof(
  ssh: ReadonlyArray<string>,
  challenge: { audience: string; peerId: string },
  accept: (proof: unknown, signal: AbortSignal) => Promise<Readonly<Record<string, unknown>>>,
  parent: AbortSignal,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(60000)])
  signal.throwIfAborted()
  const child = Bun.spawn([...ssh], {
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const stop = () => {
    child.kill("SIGKILL")
  }
  const timer = setTimeout(stop, 60000)
  signal.addEventListener("abort", stop, { once: true })
  const reader = child.stdout.getReader()
  let buffered = ""
  let size = 0
  const line = async (): Promise<unknown> => {
    while (!buffered.includes("\n")) {
      const part = await reader.read()
      if (part.done) throw new Error("private bootstrap unavailable")
      size += part.value.length
      if (size > 20000) throw new Error("private bootstrap refused")
      buffered += Buffer.from(part.value).toString("utf8")
    }
    const at = buffered.indexOf("\n")
    const result: unknown = JSON.parse(buffered.slice(0, at))
    buffered = buffered.slice(at + 1)
    return result
  }
  try {
    child.stdin.write(JSON.stringify(challenge) + "\n")
    await child.stdin.flush()
    const proof = await line()
    signal.throwIfAborted()
    const grant = await accept(proof, signal)
    signal.throwIfAborted()
    child.stdin.write(JSON.stringify(grant) + "\n")
    // The newline frames the grant; retain the channel until admission is acknowledged.
    await child.stdin.flush()
    Schema.decodeUnknownSync(Schema.Struct({ admitted: Schema.Literal(true) }), {
      onExcessProperty: "error",
    })(await line())
    await child.stdin.end()
    if ((await child.exited) !== 0) throw new Error("private bootstrap unavailable")
    signal.throwIfAborted()
  } catch {
    throw new Error("private bootstrap unavailable")
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", stop)
    stop()
    await child.exited
    reader.releaseLock()
  }
}
