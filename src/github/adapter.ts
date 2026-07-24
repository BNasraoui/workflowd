import type { Octokit as OctokitClient, RestEndpointMethodTypes } from "@octokit/rest"
import { PullRequestData } from "../domain/pull-request-transition"

type IssueCommentResponse =
  RestEndpointMethodTypes["issues"]["listComments"]["response"]["data"][number]
type CheckRunResponse =
  RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"][number]
type CommitStatusResponse =
  RestEndpointMethodTypes["repos"]["listCommitStatusesForRef"]["response"]["data"][number]

export type GitHubPullRequestData = typeof PullRequestData.Encoded & {
  readonly mergeable?: boolean | null
  readonly mergeableState?: string
}

export type GitHubIssueComment = {
  readonly id: IssueCommentResponse["id"]
  readonly body?: IssueCommentResponse["body"]
  readonly userType?: NonNullable<IssueCommentResponse["user"]>["type"]
  readonly appId?: NonNullable<IssueCommentResponse["performed_via_github_app"]>["id"]
}

export type GitHubCheckRun = {
  readonly id: CheckRunResponse["id"]
  readonly name?: string
  readonly status?: string
  readonly conclusion?: string | null
  readonly detailsUrl?: string | null
  readonly summary?: string | null
  readonly externalId?: CheckRunResponse["external_id"]
  readonly appId?: NonNullable<CheckRunResponse["app"]>["id"]
  readonly appSlug?: NonNullable<CheckRunResponse["app"]>["slug"]
}

export type GitHubWorkflowRun = {
  readonly id: number
  readonly name: string
  readonly headSha: string
  readonly status?: string | null
  readonly conclusion?: string | null
}

export type GitHubWorkflowJob = {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion?: string | null
}

export type GitHubCommitStatus = {
  readonly context: string
  readonly state: "error" | "failure" | "pending" | "success"
  readonly description?: string | null
  readonly targetUrl?: string | null
}

export type OctokitClientPort = {
  readonly getPullRequest: (
    input: RestEndpointMethodTypes["pulls"]["get"]["parameters"],
  ) => Promise<{
    readonly number: number
    readonly user: { readonly login: string } | null
    readonly base: {
      readonly ref: string
      readonly sha: string
      readonly repo: {
        readonly id: number
        readonly full_name: string
        readonly name: string
        readonly owner: { readonly login: string }
      }
    }
    readonly draft?: boolean | null
    readonly head: {
      readonly ref: string
      readonly sha: string
      readonly repo: { readonly full_name: string } | null
    }
    readonly state: "open" | "closed"
    readonly updated_at?: string
    readonly mergeable?: boolean | null
    readonly mergeable_state?: string
  }>
  readonly listIssueCommentPages: (
    input: RestEndpointMethodTypes["issues"]["listComments"]["parameters"],
  ) => AsyncIterable<ReadonlyArray<IssueCommentResponse>>
  readonly createIssueComment: (
    input: RestEndpointMethodTypes["issues"]["createComment"]["parameters"],
  ) => Promise<number>
  readonly updateIssueComment: (
    input: RestEndpointMethodTypes["issues"]["updateComment"]["parameters"],
  ) => Promise<number>
  readonly listCheckRunPages: (
    input: RestEndpointMethodTypes["checks"]["listForRef"]["parameters"],
  ) => AsyncIterable<ReadonlyArray<CheckRunResponse>>
  readonly listCommitStatusPages?: (input: {
    readonly owner: string
    readonly repo: string
    readonly ref: string
    readonly per_page: number
    readonly request?: { readonly signal?: AbortSignal }
  }) => AsyncIterable<ReadonlyArray<CommitStatusResponse>>
  readonly listWorkflowRunPages?: (input: {
    readonly owner: string
    readonly repo: string
    readonly head_sha: string
    readonly per_page: number
    readonly request?: { readonly signal?: AbortSignal }
  }) => AsyncIterable<ReadonlyArray<GitHubWorkflowRun>>
  readonly listWorkflowJobPages?: (input: {
    readonly owner: string
    readonly repo: string
    readonly run_id: number
    readonly per_page: number
    readonly request?: { readonly signal?: AbortSignal }
  }) => AsyncIterable<ReadonlyArray<GitHubWorkflowJob>>
  readonly downloadWorkflowJobLog?: (input: {
    readonly owner: string
    readonly repo: string
    readonly job_id: number
    readonly request?: { readonly signal?: AbortSignal }
  }) => Promise<string>
  readonly createCheckRun: (
    input: RestEndpointMethodTypes["checks"]["create"]["parameters"],
  ) => Promise<number>
  readonly updateCheckRun: (
    input: RestEndpointMethodTypes["checks"]["update"]["parameters"],
  ) => Promise<number>
}

export type GitHubInstallationAdapter = {
  readonly getPullRequest: (
    input: RestEndpointMethodTypes["pulls"]["get"]["parameters"],
  ) => Promise<GitHubPullRequestData>
  readonly listIssueCommentPages: (
    input: RestEndpointMethodTypes["issues"]["listComments"]["parameters"],
  ) => AsyncIterable<ReadonlyArray<GitHubIssueComment>>
  readonly createIssueComment: (
    input: RestEndpointMethodTypes["issues"]["createComment"]["parameters"],
  ) => Promise<number>
  readonly updateIssueComment: (
    input: RestEndpointMethodTypes["issues"]["updateComment"]["parameters"],
  ) => Promise<number>
  readonly listCheckRunPages: (
    input: RestEndpointMethodTypes["checks"]["listForRef"]["parameters"],
  ) => AsyncIterable<ReadonlyArray<GitHubCheckRun>>
  readonly listCommitStatusPages?: (input: {
    readonly owner: string
    readonly repo: string
    readonly ref: string
    readonly per_page: number
    readonly request?: { readonly signal?: AbortSignal }
  }) => AsyncIterable<ReadonlyArray<GitHubCommitStatus>>
  readonly listWorkflowRunPages?: NonNullable<OctokitClientPort["listWorkflowRunPages"]>
  readonly listWorkflowJobPages?: NonNullable<OctokitClientPort["listWorkflowJobPages"]>
  readonly downloadWorkflowJobLog?: NonNullable<OctokitClientPort["downloadWorkflowJobLog"]>
  readonly createCheckRun: (
    input: RestEndpointMethodTypes["checks"]["create"]["parameters"],
  ) => Promise<number>
  readonly updateCheckRun: (
    input: RestEndpointMethodTypes["checks"]["update"]["parameters"],
  ) => Promise<number>
}

export class OctokitInstallationAdapter implements GitHubInstallationAdapter {
  constructor(private readonly client: OctokitClientPort) {}

  async getPullRequest(input: Parameters<GitHubInstallationAdapter["getPullRequest"]>[0]) {
    return normalizePullRequest(await this.client.getPullRequest(input))
  }

  listIssueCommentPages(input: Parameters<GitHubInstallationAdapter["listIssueCommentPages"]>[0]) {
    return normalizeIssueCommentPages(this.client.listIssueCommentPages(input))
  }

  async createIssueComment(input: Parameters<GitHubInstallationAdapter["createIssueComment"]>[0]) {
    return this.client.createIssueComment(input)
  }

  async updateIssueComment(input: Parameters<GitHubInstallationAdapter["updateIssueComment"]>[0]) {
    return this.client.updateIssueComment(input)
  }

  listCheckRunPages(input: Parameters<GitHubInstallationAdapter["listCheckRunPages"]>[0]) {
    return normalizeCheckRunPages(this.client.listCheckRunPages(input))
  }

  listCommitStatusPages(
    input: Parameters<NonNullable<GitHubInstallationAdapter["listCommitStatusPages"]>>[0],
  ) {
    const pages = this.client.listCommitStatusPages?.(input)
    return pages === undefined
      ? emptyPages<GitHubCommitStatus>()
      : normalizeCommitStatusPages(pages)
  }

  listWorkflowRunPages(
    input: Parameters<NonNullable<GitHubInstallationAdapter["listWorkflowRunPages"]>>[0],
  ) {
    return this.client.listWorkflowRunPages?.(input) ?? emptyPages<GitHubWorkflowRun>()
  }

  listWorkflowJobPages(
    input: Parameters<NonNullable<GitHubInstallationAdapter["listWorkflowJobPages"]>>[0],
  ) {
    return this.client.listWorkflowJobPages?.(input) ?? emptyPages<GitHubWorkflowJob>()
  }

  async downloadWorkflowJobLog(
    input: Parameters<NonNullable<GitHubInstallationAdapter["downloadWorkflowJobLog"]>>[0],
  ) {
    return (await this.client.downloadWorkflowJobLog?.(input)) ?? ""
  }

  async createCheckRun(input: Parameters<GitHubInstallationAdapter["createCheckRun"]>[0]) {
    return this.client.createCheckRun(input)
  }

  async updateCheckRun(input: Parameters<GitHubInstallationAdapter["updateCheckRun"]>[0]) {
    return this.client.updateCheckRun(input)
  }
}

function normalizePullRequest(
  pullRequest: Awaited<ReturnType<OctokitClientPort["getPullRequest"]>>,
): GitHubPullRequestData {
  if (pullRequest.user === null) {
    throw new Error("Pull request author is unavailable")
  }
  if (pullRequest.head.repo === null) {
    throw new Error("Pull request head repository is unavailable")
  }

  return {
    repository: {
      id: pullRequest.base.repo.id,
      fullName: pullRequest.base.repo.full_name,
      name: pullRequest.base.repo.name,
      owner: pullRequest.base.repo.owner.login,
    },
    pullRequest: {
      number: pullRequest.number,
      author: pullRequest.user.login,
      baseRef: pullRequest.base.ref,
      baseSha: pullRequest.base.sha,
      draft: pullRequest.draft ?? false,
      headRef: pullRequest.head.ref,
      headRepositoryFullName: pullRequest.head.repo.full_name,
      headSha: pullRequest.head.sha,
      state: pullRequest.state,
      ...(pullRequest.updated_at === undefined ? {} : { updatedAt: pullRequest.updated_at }),
    },
    ...(pullRequest.mergeable === undefined ? {} : { mergeable: pullRequest.mergeable }),
    ...(pullRequest.mergeable_state === undefined
      ? {}
      : { mergeableState: pullRequest.mergeable_state }),
  }
}

async function* normalizeIssueCommentPages(
  pages: AsyncIterable<ReadonlyArray<IssueCommentResponse>>,
): AsyncIterable<ReadonlyArray<GitHubIssueComment>> {
  for await (const page of pages) {
    yield page.map((comment) => ({
      id: comment.id,
      ...(comment.body === undefined ? {} : { body: comment.body }),
      ...(comment.user?.type === undefined ? {} : { userType: comment.user.type }),
      ...(comment.performed_via_github_app?.id === undefined
        ? {}
        : { appId: comment.performed_via_github_app.id }),
    }))
  }
}

async function* normalizeCheckRunPages(
  pages: AsyncIterable<ReadonlyArray<CheckRunResponse>>,
): AsyncIterable<ReadonlyArray<GitHubCheckRun>> {
  for await (const page of pages) {
    yield page.map((checkRun) => ({
      id: checkRun.id,
      name: checkRun.name,
      status: checkRun.status,
      conclusion: checkRun.conclusion,
      detailsUrl: checkRun.details_url,
      summary: checkRun.output?.summary,
      ...(checkRun.external_id === undefined ? {} : { externalId: checkRun.external_id }),
      ...(checkRun.app?.id === undefined ? {} : { appId: checkRun.app.id }),
      ...(checkRun.app?.slug === undefined ? {} : { appSlug: checkRun.app.slug }),
    }))
  }
}

async function* normalizeCommitStatusPages(
  pages: AsyncIterable<ReadonlyArray<CommitStatusResponse>>,
): AsyncIterable<ReadonlyArray<GitHubCommitStatus>> {
  for await (const page of pages) {
    yield page.map((status) => ({
      context: status.context,
      state: normalizeCommitState(status.state),
      description: status.description,
      targetUrl: status.target_url,
    }))
  }
}

function normalizeCommitState(state: string): GitHubCommitStatus["state"] {
  switch (state) {
    case "error":
    case "failure":
    case "pending":
    case "success":
      return state
    default:
      return "error"
  }
}

export function makeOctokitClientPort(client: OctokitClient): OctokitClientPort {
  return {
    getPullRequest: async (input) => (await client.rest.pulls.get(input)).data,
    listIssueCommentPages: async function* (input) {
      for await (const response of client.paginate.iterator(
        client.rest.issues.listComments,
        input,
      )) {
        yield response.data
      }
    },
    createIssueComment: async (input) => (await client.rest.issues.createComment(input)).data.id,
    updateIssueComment: async (input) => (await client.rest.issues.updateComment(input)).data.id,
    listCheckRunPages: async function* (input) {
      for await (const response of client.paginate.iterator(client.rest.checks.listForRef, input)) {
        yield response.data
      }
    },
    listCommitStatusPages: async function* (input) {
      for await (const response of client.paginate.iterator(
        client.rest.repos.listCommitStatusesForRef,
        input,
      )) {
        yield response.data
      }
    },
    listWorkflowRunPages: async function* (input) {
      for await (const response of client.paginate.iterator(
        client.rest.actions.listWorkflowRunsForRepo,
        input,
      )) {
        yield response.data.map((run) => ({
          id: run.id,
          name: run.name ?? "GitHub Actions",
          headSha: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
        }))
      }
    },
    listWorkflowJobPages: async function* (input) {
      for await (const response of client.paginate.iterator(
        client.rest.actions.listJobsForWorkflowRun,
        input,
      )) {
        yield response.data.map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
        }))
      }
    },
    downloadWorkflowJobLog: async (input) => {
      const response = await client.rest.actions.downloadJobLogsForWorkflowRun(input)
      return typeof response.data === "string" ? response.data : JSON.stringify(response.data)
    },
    createCheckRun: async (input) => (await client.rest.checks.create(input)).data.id,
    updateCheckRun: async (input) => (await client.rest.checks.update(input)).data.id,
  }
}

async function* emptyPages<A>(): AsyncIterable<ReadonlyArray<A>> {
  await Promise.resolve()
  yield []
}
