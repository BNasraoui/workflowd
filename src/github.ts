import { Context, Data, Effect } from "effect"
import { AuthoritativePullRequestSnapshot } from "./domain/pull-request-transition"
import type { Publication } from "./domain/publication"
import { normalizeError } from "./errors"
import type { GitHubInstallationAdapter } from "./github/adapter"
import {
  presentReviewCheck,
  renderReviewComment,
  reviewMarker,
} from "./github/review-presentation"

type InstallationClientProvider = (
  installationId: number,
) => Promise<GitHubInstallationAdapter>

type RepositoryName = {
  readonly owner: string
  readonly repo: string
}

export class GitHubClientError extends Data.TaggedError("GitHubClientError")<{
  readonly operation: string
  readonly cause: Error
}> {}

export type FetchPullRequestSnapshotInput = {
  readonly installationId: number
  readonly repositoryFullName: string
  readonly pullRequestNumber: number
}

export type PullRequestSnapshot =
  typeof AuthoritativePullRequestSnapshot.Encoded

export type PublicationCurrentness<E, R> = (
  now: Date,
) => Effect.Effect<boolean, E, R>

export type GitHubPort = {
  readonly publishReview: <E, R>(
    publication: Publication,
    isCurrent: PublicationCurrentness<E, R>,
  ) => Effect.Effect<"published" | "stale", GitHubClientError | E, R>
  readonly fetchPullRequestSnapshot: (
    input: FetchPullRequestSnapshotInput,
  ) => Effect.Effect<PullRequestSnapshot, GitHubClientError>
}

export const GitHub = Context.GenericTag<GitHubPort>("workflowd/GitHub")

export class GitHubAppAdapter implements GitHubPort {
  constructor(
    private readonly appId: number,
    private readonly getInstallationClient: InstallationClientProvider,
  ) {}

  readonly fetchPullRequestSnapshot = (
    input: FetchPullRequestSnapshotInput,
  ): Effect.Effect<PullRequestSnapshot, GitHubClientError> =>
    Effect.gen(this, function* () {
      const repository = yield* parseRepositoryName(input.repositoryFullName)
      const client = yield* this.client(input.installationId)
      const snapshot = yield* this.attempt("get pull request", (signal) =>
        client.getPullRequest({
          ...repository,
          pull_number: input.pullRequestNumber,
          request: { signal },
        }),
      )
      return {
        _tag: "AuthoritativePullRequestSnapshot",
        installationId: input.installationId,
        ...snapshot,
      }
    })

  readonly publishReview = <E, R>(
    publication: Publication,
    isCurrent: PublicationCurrentness<E, R>,
  ): Effect.Effect<"published" | "stale", GitHubClientError | E, R> =>
    Effect.gen(this, function* () {
      const repository = yield* parseRepositoryName(
        publication.repositoryFullName,
      )
      const client = yield* this.client(publication.installationId)
      const pull = yield* this.attempt("get pull request", (signal) =>
        client.getPullRequest({
          ...repository,
          pull_number: publication.pullRequestNumber,
          request: { signal },
        }),
      )
      if (
        pull.pullRequest.state !== "open" ||
        pull.pullRequest.draft ||
        pull.pullRequest.baseSha !== publication.target.baseSha ||
        pull.pullRequest.baseRef !== publication.target.baseRef ||
        pull.pullRequest.headSha !== publication.target.headSha ||
        pull.pullRequest.headRef !== publication.target.headRef ||
        pull.pullRequest.headRepositoryFullName !==
          publication.target.headRepositoryFullName
      ) {
        return "stale" as const
      }

      const comment = renderReviewComment(publication)
      const commentOutcome = yield* this.publishComment(
        client,
        repository,
        publication,
        comment,
        isCurrent,
      )
      if (commentOutcome === "stale") return "stale" as const
      const checkOutcome = yield* this.publishCheck(
        client,
        repository,
        publication,
        comment,
        isCurrent,
      )
      if (checkOutcome === "stale") return "stale" as const
      return "published" as const
    })

  private client(
    installationId: number,
  ): Effect.Effect<GitHubInstallationAdapter, GitHubClientError> {
    return this.attempt("get installation client", () =>
      this.getInstallationClient(installationId),
    )
  }

  private publishComment<E, R>(
    client: GitHubInstallationAdapter,
    repository: RepositoryName,
    publication: Publication,
    body: string,
    isCurrent: PublicationCurrentness<E, R>,
  ): Effect.Effect<"published" | "stale", GitHubClientError | E, R> {
    return Effect.gen(this, function* () {
      const existing = yield* this.ownedComment(
        client,
        repository,
        publication,
      )
      const write =
        existing === undefined
          ? (signal: AbortSignal) =>
              client.createIssueComment({
                ...repository,
                issue_number: publication.pullRequestNumber,
                body,
                request: { signal },
              })
          : (signal: AbortSignal) =>
              client.updateIssueComment({
                ...repository,
                comment_id: existing.id,
                body,
                request: { signal },
              })
      const now = new Date(
        yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      )
      if (!(yield* isCurrent(now))) return "stale" as const
      yield* this.attempt(
        `${existing === undefined ? "create" : "update"} review comment`,
        write,
      )
      return "published" as const
    })
  }

  private ownedComment(
    client: GitHubInstallationAdapter,
    repository: RepositoryName,
    publication: Publication,
  ) {
    return this.attempt("list issue comments", async (signal) => {
      const marker = reviewMarker(publication)
      for await (const page of client.listIssueCommentPages({
        ...repository,
        issue_number: publication.pullRequestNumber,
        per_page: 100,
        request: { signal },
      })) {
        const found = page.find(
          (comment) =>
            comment.userType === "Bot" &&
            comment.appId === this.appId &&
            comment.body?.includes(marker) === true,
        )
        if (found !== undefined) return found
      }
      return undefined
    })
  }

  private publishCheck<E, R>(
    client: GitHubInstallationAdapter,
    repository: RepositoryName,
    publication: Publication,
    comment: string,
    isCurrent: PublicationCurrentness<E, R>,
  ): Effect.Effect<"published" | "stale", GitHubClientError | E, R> {
    return Effect.gen(this, function* () {
      const existing = yield* this.ownedCheck(client, repository, publication)
      const presentation = presentReviewCheck(publication, comment)
      const now = new Date(
        yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      )
      if (!(yield* isCurrent(now))) return "stale" as const
      const check = {
        ...repository,
        name: "OpenCode Review",
        status: "completed" as const,
        ...presentation,
        completed_at: now.toISOString(),
        external_id: publication.operationKey,
      }
      const write =
        existing === undefined
          ? (signal: AbortSignal) =>
              client.createCheckRun({
                ...check,
                head_sha: publication.target.headSha,
                request: { signal },
              })
          : (signal: AbortSignal) =>
              client.updateCheckRun({
                ...check,
                check_run_id: existing.id,
                request: { signal },
              })
      yield* this.attempt(
        `${existing === undefined ? "create" : "update"} check run`,
        write,
      )
      return "published" as const
    })
  }

  private ownedCheck(
    client: GitHubInstallationAdapter,
    repository: RepositoryName,
    publication: Publication,
  ) {
    return this.attempt("list check runs", async (signal) => {
      for await (const page of client.listCheckRunPages({
        ...repository,
        ref: publication.target.headSha,
        check_name: "OpenCode Review",
        app_id: this.appId,
        per_page: 100,
        request: { signal },
      })) {
        const found = page.find(
          (check) =>
            check.appId === this.appId &&
            check.externalId === publication.operationKey,
        )
        if (found !== undefined) return found
      }
      return undefined
    })
  }

  private attempt<A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, GitHubClientError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new GitHubClientError({ operation, cause: normalizeError(cause) }),
    })
  }
}

function parseRepositoryName(
  repositoryFullName: string,
): Effect.Effect<RepositoryName, GitHubClientError> {
  const [owner, repo] = repositoryFullName.split("/", 2)
  return owner && repo
    ? Effect.succeed({ owner, repo })
    : Effect.fail(
        new GitHubClientError({
          operation: "parse repository name",
          cause: new Error(`Invalid repository name: ${repositoryFullName}`),
        }),
      )
}
