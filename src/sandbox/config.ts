import { Schema } from "effect"

const PublicationCoAuthor = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.isWellFormed() &&
      !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value) &&
      /^[^\s<>][^<>]* <[^\s<>@]+@[^\s<>@]+>$/u.test(value),
  ),
)

export function publicationCommitMessage(message: string, coAuthor: string): string {
  const body = message
    .split("\n")
    .filter((line) => !/^\s*co-authored-by\s*:/i.test(line))
    .join("\n")
    .trimEnd()
  return `${body}\n\nCo-authored-by: ${coAuthor}`
}

export function publicationBody(marker: string, message: string): string {
  const longest = Math.max(2, ...Array.from(message.matchAll(/`+/g), (match) => match[0].length))
  const fence = "`".repeat(longest + 1)
  return `${marker}\n\n${fence}text\n${message}\n${fence}`
}

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
      coAuthor: PublicationCoAuthor,
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

export const PublicationTitle = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      value.isWellFormed() &&
      [...value].length <= 200 &&
      !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value),
  ),
)
export const PublicationMessage = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      value.isWellFormed() &&
      Buffer.byteLength(value, "utf8") <= 10240 &&
      !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll("\n", "")),
  ),
)

// The selected environment is an identity; branch is opaque agent data.
export const SandboxCompletion = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  branch: Schema.String,
  title: PublicationTitle,
  commitMessage: PublicationMessage,
})

export const sandboxCompletionInstructions =
  "Work only in container-use environments. Do not create git branches inside the container. " +
  "Finish by calling submit_result on your owned sandbox MCP server with exactly environmentId (the exact ID of the environment holding your result), " +
  "branch (the branch name you choose), title (your PR title, non-empty, one line, at most 200 Unicode characters), " +
  "and commitMessage (your non-empty commit message, at most 10 KiB of UTF-8). Both must be valid Unicode plain text with no control characters; only the message may contain newlines. " +
  "The publisher creates the branch, squashes your commits into one commit with your message and opens a draft PR with your title. Do not push."
