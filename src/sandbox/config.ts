import { Schema } from "effect"

const positiveId = Schema.Int.check(Schema.isGreaterThan(0))
export const SandboxPolicy = Schema.Struct({
  alias: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)),
  repository: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)),
  repositoryId: positiveId,
  installationId: positiveId,
  workflowSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  appActorId: positiveId,
  toolingSha: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  publish: Schema.optionalKey(
    Schema.Struct({
      baseRef: Schema.String,
      environmentId: positiveId,
      publisherAppId: positiveId,
      publisherActorId: positiveId,
    }),
  ),
  tailscaleClientId: Schema.NonEmptyString,
  tailscaleAudience: Schema.NonEmptyString,
})
export type SandboxPolicy = typeof SandboxPolicy.Type

export function parseSandboxRepositories(value: string | undefined): ReadonlyArray<SandboxPolicy> {
  if (value === undefined) return []
  const policies = Schema.decodeUnknownSync(Schema.Array(SandboxPolicy))(JSON.parse(value))
  for (const key of ["alias", "repository", "repositoryId"] as const) {
    if (
      new Set(policies.map((policy) => String(policy[key]).toLowerCase())).size !== policies.length
    )
      throw new Error(`Duplicate sandbox ${key}`)
  }
  return policies
}

// The selected environment is an identity; branch is opaque agent data.
export const SandboxCompletion = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  branch: Schema.String,
})

export const sandboxCompletionInstructions =
  "Work only in container-use environments. Do not create git branches inside the container. " +
  "Finish by calling submit_result on your owned sandbox MCP server with exactly environmentId (the exact ID of the environment holding your result) " +
  "and branch (the branch name you choose). The publisher creates the branch. Do not push."
