import { Schema } from "effect"
import { safePublication } from "../../deploy/sandbox/publication.mjs"
import skills from "../../deploy/sandbox/skills/catalog.json"
import { publicBootstrapFields } from "../../deploy/sandbox/public-output.mjs"

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
export const PrivateBootstrapPolicy = Schema.Struct({
  repositoryOwnerId: positiveId,
  mode: Schema.Literals(["remote-tools", "actions-native"]),
})
export const CapabilityGatewayConfig = Schema.Struct({
  gitRead: Schema.optionalKey(Schema.Boolean),
  native: Schema.optionalKey(
    Schema.Struct({
      protocol: Schema.Literals(["codex-chatgpt", "openai-chat"]),
      models: Schema.Array(
        Schema.Struct({
          id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)),
          efforts: Schema.Array(Schema.Literals(["low", "medium", "high", "xhigh"])).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(4),
          ),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    }),
  ),
  nodeBinary: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_.-]+$/)),
  noscope: Schema.Struct({
    binary: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_.-]+$/)),
    configHome: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_.-]+$/)),
  }),
  providerId: Schema.NonEmptyString,
  credentialRole: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)),
  maxStreams: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 })),
  maxStreamsPerRun: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
})
export type CapabilityGatewayConfig = typeof CapabilityGatewayConfig.Type
export const SandboxPolicy = Schema.Struct({
  privateBootstrap: Schema.optionalKey(PrivateBootstrapPolicy),
  alias: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)),
  repository: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)),
  repositoryId: positiveId,
  installationId: positiveId,
  workflowSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  appActorId: positiveId,
  agentImage: Schema.String.check(
    Schema.isPattern(/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/),
  ),
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
  tailscaleClientId: Schema.String.check(Schema.isPattern(publicBootstrapFields.tailscaleClientId)),
  tailscaleAudience: Schema.String.check(Schema.isPattern(publicBootstrapFields.tailscaleAudience)),
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
      safePublication(value) &&
      [...value].length <= 200 &&
      !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value),
  ),
)
export const PublicationMessage = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      safePublication(value, true) &&
      Buffer.byteLength(value, "utf8") <= 10240 &&
      !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll("\n", "")),
  ),
)

export const PublicationBody = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= 32768 &&
      safePublication(value),
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

export const sandboxPublicationRules =
  "Title, commitMessage and body must contain no character references (such as &amp;), hidden/default-ignorable characters, link reference definitions, or issue-closing keyword followed by an issue reference (including Unicode/Markdown disguises, even in code). Ordinary prose such as 'this fixes the race' is allowed. " +
  "commitMessage is plain text: <, @, $ and backslashes are forbidden everywhere, including fences. In body, only validated fenced code may contain those characters. Backslash checks include Unicode compatibility forms. Open a fence at column 0 after a blank line or at the start, using 3+ identical backticks or tildes; close it with exactly the same run at column 0 and nothing else. " +
  "The info string must be empty or exactly text, diff, ts, typescript, tsx, js, json, sh, bash, python, rust, go, sql, yaml or toml. No indented, nested, mismatched or unclosed fences, math/diagram fences, or inline-code exceptions. "

export const sandboxCompletionInstructions =
  "Work only in container-use environments. Do not create git branches inside the container. " +
  'Every container-use call must pass environment_source "/workspace/repository". ' +
  "Finish by calling submit_result on your owned sandbox MCP server with exactly environmentId (the exact ID of the environment holding your result), " +
  "branch (the branch name you choose), title (your PR title, non-empty, one line, at most 200 Unicode characters), " +
  "commitMessage (your non-empty commit message, at most 10 KiB of UTF-8), and body (your PR description in GitHub Markdown, at most 32 KiB of UTF-8). " +
  "All text must be valid Unicode with no control or format characters; only commitMessage and body may contain newlines. " +
  sandboxPublicationRules +
  "The publisher creates the branch, squashes your commits into one commit with your message and opens a draft PR with your title and body. Do not push. " +
  "Use visual-pr to write body and pass it to submit_result; correct any tool validation error and resubmit. " +
  "Repository skills also live inside your environment at /workdir/.agents/skills and /workdir/.claude/skills when present. " +
  `Read the following pinned skills through container-use inside your environment at ${skills.root}/. ` +
  "Resolve each skill’s relative references inside its full installed folder. Task context is supplied here; do not use skills that require unavailable tools or network.\n\n" +
  skills.skills
    .map((skill) => `- ${skill.name}: ${skill.description} (${skills.root}/${skill.name}/SKILL.md)`)
    .join("\n")
