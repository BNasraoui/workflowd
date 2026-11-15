import { createPublicKey, verify } from "node:crypto"
import { Schema } from "effect"

const githubIssuer = "https://token.actions.githubusercontent.com"
const Header = Schema.Struct({
  alg: Schema.Literal("RS256"),
  typ: Schema.Literal("JWT"),
  kid: Schema.NonEmptyString,
  // GitHub may name the key's thumbprint too; the key is selected by kid alone.
  x5t: Schema.optionalKey(Schema.String),
})
/** A proof issued this far ahead of this clock is still accepted; its expiry has no leeway. */
const issuedLeewayMs = 10000
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
      claims.nbf * 1000 > now + issuedLeewayMs ||
      claims.iat * 1000 > now + issuedLeewayMs ||
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
