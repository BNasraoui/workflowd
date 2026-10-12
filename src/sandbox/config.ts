import { Schema } from "effect"
import skills from "../../deploy/sandbox/skills/catalog.json"

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

export function publicationBody(marker: string, body: string): string {
  return `${marker}\n\n${body}`
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

// Reject conservatively, including in code spans: GitHub's Markdown/linkification
// rules must not decide whether approved text can hide content or notify people.
export const PublicationBody = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      value.trim().length > 0 &&
      value.isWellFormed() &&
      Buffer.byteLength(value, "utf8") <= 32768 &&
      !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll("\n", "")) &&
      !/[<@]/u.test(value) &&
      !/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/iu.test(value),
  ),
)

// The selected environment is an identity; branch is opaque agent data.
export const SandboxCompletion = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  branch: Schema.String,
  title: PublicationTitle,
  commitMessage: PublicationMessage,
  body: PublicationBody,
})

export const sandboxCompletionInstructions =
  "Work only in container-use environments. Do not create git branches inside the container. " +
  'Every container-use call must pass environment_source "/workspace/repository". ' +
  "Finish by calling submit_result on your owned sandbox MCP server with exactly environmentId (the exact ID of the environment holding your result), " +
  "branch (the branch name you choose), title (your PR title, non-empty, one line, at most 200 Unicode characters), " +
  "commitMessage (your non-empty commit message, at most 10 KiB of UTF-8), and body (your PR description in GitHub Markdown, at most 32 KiB of UTF-8). " +
  "All text must be valid Unicode with no control or format characters; only commitMessage and body may contain newlines. " +
  "The body must contain no raw HTML or <, no @ mentions, and none of the GitHub closing words close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, even in code examples. " +
  "The publisher creates the branch, squashes your commits into one commit with your message and opens a draft PR with your title and body. Do not push. " +
  "Use visual-pr to write body and pass it to submit_result; correct any tool validation error and resubmit. " +
  `Read the following skills through container-use inside your environment at ${skills.root}/. ` +
  "Resolve each skill’s relative references inside its full installed folder. Task context is supplied here; do not use skills that require unavailable tools or network.\n\n" +
  skills.skills
    .map((skill) => `- ${skill.name}: ${skill.description} (${skills.root}/${skill.name}/SKILL.md)`)
    .join("\n")
