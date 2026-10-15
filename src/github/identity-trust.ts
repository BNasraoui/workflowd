import { Schema } from "effect"

// These fields must come from a verified GitHub webhook or the PR API.
export const IdentityPull = Schema.Struct({
  number: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  user: Schema.optional(Schema.Struct({ login: Schema.NonEmptyString })),
  author_association: Schema.optional(Schema.String),
  head: Schema.Struct({
    sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
  }),
})

export const identityTrusted = (
  baseRepository: string,
  headRepository: string | undefined,
  association: string | undefined,
) =>
  headRepository?.toLowerCase() === baseRepository.toLowerCase() ||
  ["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? "")
