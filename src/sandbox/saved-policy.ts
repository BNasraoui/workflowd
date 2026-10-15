import { Schema } from "effect"

// Persistence contract, deliberately independent of dispatch validation. Fields added
// after the first lease must remain optional here; never invent historical identity.
const positiveId = Schema.Int.check(Schema.isGreaterThan(0))
export const SavedSandboxPolicy = Schema.Struct({
  alias: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)),
  repository: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)),
  repositoryId: positiveId,
  installationId: positiveId,
  workflowSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  appActorId: positiveId,
  agentImage: Schema.optionalKey(Schema.String),
  toolingSha: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  publish: Schema.optionalKey(
    Schema.Struct({
      baseRef: Schema.String,
      environmentId: positiveId,
      publisherAppId: positiveId,
      publisherActorId: positiveId,
      coAuthor: Schema.optionalKey(Schema.String),
    }),
  ),
  tailscaleClientId: Schema.NonEmptyString,
  tailscaleAudience: Schema.NonEmptyString,
})
export type SavedSandboxPolicy = typeof SavedSandboxPolicy.Type
