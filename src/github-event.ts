import { Data, Effect, Schema } from "effect"
import { Command } from "./domain/command"
import {
  PullRequestObservation,
  PullRequestRef as PullRequestRefSchema,
  RepositoryRef as RepositoryRefSchema,
} from "./domain/pull-request-transition"

export type RepositoryRef = typeof RepositoryRefSchema.Encoded
export type PullRequestRef = typeof PullRequestRefSchema.Encoded

export type GitHubEvent =
  | typeof PullRequestObservation.Type
  | typeof Command.Type
  | { readonly _tag: "Ignored"; readonly reason: string }

export class InvalidGitHubEvent extends Data.TaggedError("InvalidGitHubEvent")<{
  readonly message: string
}> {}

const PullRequestPayload = Schema.Struct({
  action: Schema.NonEmptyString,
  installation: Schema.optional(Schema.Struct({ id: Schema.Number })),
  repository: Schema.Struct({
    id: Schema.Number,
    full_name: Schema.String,
    name: Schema.String,
    owner: Schema.Struct({ login: Schema.String }),
  }),
  pull_request: Schema.Struct({
    number: Schema.Number,
    draft: Schema.optional(Schema.Boolean),
    state: Schema.Literal("open", "closed"),
    user: Schema.Struct({ login: Schema.String }),
    head: Schema.Struct({
      sha: Schema.String,
      ref: Schema.String,
      repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
    }),
    base: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
    updated_at: Schema.optional(Schema.String),
  }),
})

const IssueCommentPayload = Schema.Struct({
  action: Schema.String,
  installation: Schema.optional(Schema.Struct({ id: Schema.Number })),
  repository: Schema.Struct({
    id: Schema.Number,
    full_name: Schema.String,
    name: Schema.String,
    owner: Schema.Struct({ login: Schema.String }),
  }),
  issue: Schema.Struct({
    number: Schema.Number,
    pull_request: Schema.optional(Schema.Struct({ url: Schema.NonEmptyString })),
  }),
  comment: Schema.Struct({
    id: Schema.Number,
    body: Schema.NonEmptyString,
    user: Schema.Struct({ login: Schema.String }),
  }),
})

export function decodeGitHubEvent(
  event: string,
  payload: unknown,
): Effect.Effect<GitHubEvent, InvalidGitHubEvent> {
  if (event === "issue_comment") {
    return Schema.decodeUnknown(IssueCommentPayload)(payload).pipe(
      Effect.mapError(
        (error) => new InvalidGitHubEvent({ message: String(error) }),
      ),
      Effect.flatMap((decoded): Effect.Effect<GitHubEvent, InvalidGitHubEvent> => {
        if (decoded.installation === undefined) {
          return Effect.succeed({ _tag: "Ignored", reason: "missing-installation" })
        }
        if (decoded.action !== "created") {
          return Effect.succeed({ _tag: "Ignored", reason: "comment-action" })
        }
        if (decoded.issue.pull_request === undefined) {
          return Effect.succeed({ _tag: "Ignored", reason: "not-a-pull-request" })
        }
        const match = decoded.comment.body
          .trim()
          .match(/^\/agent\s+(review|fix|status)\s*$/i)
        if (match === null) {
          return Effect.succeed({ _tag: "Ignored", reason: "not-an-agent-command" })
        }

        return Schema.decodeUnknown(Command)({
          _tag: "Command",
          action: decoded.action,
          command: match[1]!.toLowerCase(),
          commentId: decoded.comment.id,
          commenter: decoded.comment.user.login,
          installationId: decoded.installation.id,
          pullRequestNumber: decoded.issue.number,
          repository: {
            id: decoded.repository.id,
            fullName: decoded.repository.full_name,
            name: decoded.repository.name,
            owner: decoded.repository.owner.login,
          },
        }).pipe(
          Effect.mapError(
            (error) => new InvalidGitHubEvent({ message: String(error) }),
          ),
        )
      }),
    )
  }

  if (event !== "pull_request") {
    return Effect.succeed({ _tag: "Ignored", reason: `unsupported:${event}` })
  }

  return Schema.decodeUnknown(PullRequestPayload)(payload).pipe(
    Effect.mapError(
      (error) => new InvalidGitHubEvent({ message: String(error) }),
    ),
    Effect.flatMap(
      (decoded): Effect.Effect<GitHubEvent, InvalidGitHubEvent> => {
        if (decoded.installation === undefined) {
          return Effect.succeed({
            _tag: "Ignored" as const,
            reason: "missing-installation",
          })
        }
        if (decoded.pull_request.head.repo === null) {
          return Effect.fail(
            new InvalidGitHubEvent({
              message: "pull request head repository is unavailable",
            }),
          )
        }

        return Schema.decodeUnknown(PullRequestObservation)({
          _tag: "PullRequest",
          action: decoded.action,
          installationId: decoded.installation.id,
          repository: {
            id: decoded.repository.id,
            fullName: decoded.repository.full_name,
            name: decoded.repository.name,
            owner: decoded.repository.owner.login,
          },
          pullRequest: {
            number: decoded.pull_request.number,
            author: decoded.pull_request.user.login,
            baseRef: decoded.pull_request.base.ref,
            baseSha: decoded.pull_request.base.sha,
            draft: decoded.pull_request.draft ?? false,
            headRef: decoded.pull_request.head.ref,
            headRepositoryFullName: decoded.pull_request.head.repo.full_name,
            headSha: decoded.pull_request.head.sha,
            state: decoded.pull_request.state,
            ...(decoded.pull_request.updated_at === undefined
              ? {}
              : { updatedAt: decoded.pull_request.updated_at }),
          },
        }).pipe(
          Effect.mapError(
            (error) => new InvalidGitHubEvent({ message: String(error) }),
          ),
        )
      },
    ),
  )
}
