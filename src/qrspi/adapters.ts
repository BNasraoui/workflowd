import { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { normalizeError } from "../errors"
import type { QrspiConfig } from "../config"
import {
  QrspiRepositoryError,
  TicketSourceError,
  TicketSourceMalformedError,
  type QrspiRepositoryPort,
  type TicketSourcePort,
} from "./ports"
import type { RepositoryReference, TicketReference } from "./domain"
import { createHash } from "node:crypto"
import type { JsonValue } from "../json"
import { runWorkspaceCommandBytes } from "../workspace/command"
import type { WorkspaceError } from "../workspace/errors"

const RawBead = Schema.Struct({
  id: Schema.String,
  issue_type: Schema.Literal("bug", "feature", "task", "epic", "chore", "decision"),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  acceptance_criteria: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
})
const RawBeads = Schema.Array(RawBead).pipe(Schema.itemsCount(1))

export class BeadsCliTicketSource implements TicketSourcePort {
  constructor(
    private readonly workspace: string,
    private readonly trackerInstanceId: string,
    private readonly command: {
      readonly run: (
        operation: string,
        command: ReadonlyArray<string>,
        options: { readonly maxStdoutBytes: number },
      ) => Effect.Effect<
        { readonly stdout: Uint8Array; readonly truncated: boolean },
        WorkspaceError
      >
    } = { run: runWorkspaceCommandBytes },
  ) {}

  readonly read = (reference: TicketReference) =>
    Effect.gen(this, function* () {
      if (reference.trackerInstanceId !== this.trackerInstanceId) {
        return yield* Effect.fail(
          new TicketSourceError({ cause: new Error("Cross-workspace ticket rejected") }),
        )
      }
      const result = yield* this.command
        .run(
          "read Beads ticket",
          [
            "bd",
            "--readonly",
            "-q",
            "-C",
            this.workspace,
            "show",
            reference.nativeTicketId,
            "--json",
          ],
          { maxStdoutBytes: 256_000 },
        )
        .pipe(Effect.mapError((error) => new TicketSourceError({ cause: error })))
      if (result.truncated) {
        return yield* Effect.fail(
          new TicketSourceError({ cause: new Error("Beads ticket exceeded the bounded envelope") }),
        )
      }
      const stdout = new TextDecoder().decode(result.stdout)
      const beads = yield* Schema.decodeUnknown(Schema.parseJson(RawBeads))(stdout).pipe(
        Effect.mapError(
          (cause) => new TicketSourceMalformedError({ cause: normalizeError(cause) }),
        ),
      )
      const bead = beads[0]
      if (bead === undefined) {
        return yield* Effect.fail(
          new TicketSourceError({ cause: new Error("Beads returned no ticket") }),
        )
      }
      if (bead.id !== reference.nativeTicketId) {
        return yield* Effect.fail(
          new TicketSourceError({
            cause: new Error("Beads returned an ambiguous ticket identity"),
          }),
        )
      }
      return ticketFromBead(reference, bead)
    })
}

function ticketFromBead(reference: TicketReference, bead: typeof RawBead.Type): JsonValue {
  const description = bead.description ?? ""
  const criteriaText = bead.acceptance_criteria ?? ""
  const userStory = markdownSection(description, "User Story")
  const productDescription = markdownSection(description, "Description")
  const sources = markdownList(markdownSection(description, "Sources"))
  const outOfScope = markdownList(markdownSection(description, "Out of Scope"))
  const acceptanceCriteria = markdownList(markdownSection(criteriaText, "Acceptance Criteria"))
  const scenarios = parseScenarios(markdownSection(criteriaText, "Scenarios"))
  return {
    reference,
    issueType: bead.issue_type,
    ...(bead.title?.trim() ? { title: bead.title.trim() } : {}),
    ...(userStory ? { userStory } : {}),
    ...(productDescription ? { description: productDescription } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(outOfScope.length > 0 ? { outOfScope } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(scenarios.length > 0 ? { scenarios } : {}),
    ...(bead.updated_at === undefined ? {} : { sourceRevision: bead.updated_at }),
  }
}

function markdownSection(text: string, heading: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i").exec(
    text,
  )
  const value = match?.[1]?.trim()
  return value ? value : undefined
}

function markdownList(section: string | undefined): string[] {
  if (section === undefined) return []
  return section
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined)
}

function parseScenarios(section: string | undefined) {
  if (section === undefined) return []
  const matches = [
    ...section.matchAll(
      /###\s+Scenario:\s*(.+?)\s*\n+\s*\*\*Given\*\*\s*(.+?)\s*\n+\s*\*\*When\*\*\s*(.+?)\s*\n+\s*\*\*Then\*\*\s*(.+?)(?=\n###\s+Scenario:|$)/gis,
    ),
  ]
  return matches.map((match) => ({
    name: match[1]?.trim() ?? "",
    given: match[2]?.trim() ?? "",
    when: match[3]?.trim() ?? "",
    then: match[4]?.trim() ?? "",
  }))
}

type RepositoriesApi = Octokit["rest"]["repos"]
type PullsApi = Octokit["rest"]["pulls"]
type GitApi = Octokit["rest"]["git"]
type QrspiOctokit = {
  readonly rest: {
    readonly repos: {
      readonly get: (
        input: Parameters<RepositoriesApi["get"]>[0],
      ) => Promise<{ readonly data: { readonly id: number; readonly full_name: string } }>
      readonly getBranch: (
        input: Parameters<RepositoriesApi["getBranch"]>[0],
      ) => Promise<{ readonly data: { readonly commit: { readonly sha: string } } }>
      readonly getCommit?: (input: Parameters<RepositoriesApi["getCommit"]>[0]) => Promise<{
        readonly data: {
          readonly sha: string
          readonly parents: ReadonlyArray<{ readonly sha: string }>
          readonly commit: {
            readonly message: string
            readonly verification?: { readonly verified?: boolean } | null
          }
        }
      }>
    }
    readonly pulls: {
      readonly list: (input: Parameters<PullsApi["list"]>[0]) => Promise<{
        readonly data: ReadonlyArray<{
          readonly number: number
          readonly draft?: boolean | null
          readonly body?: string | null
          readonly html_url: string
          readonly base: { readonly ref: string }
          readonly head: { readonly ref: string; readonly sha: string }
        }>
      }>
      readonly create?: (input: Parameters<PullsApi["create"]>[0]) => Promise<{
        readonly data: { readonly number: number }
      }>
      readonly get?: (input: Parameters<PullsApi["get"]>[0]) => Promise<{
        readonly data: {
          readonly number: number
          readonly draft?: boolean | null
          readonly body?: string | null
          readonly html_url: string
          readonly base: { readonly ref: string }
          readonly head: { readonly ref: string; readonly sha: string }
        }
      }>
    }
    readonly git: {
      readonly createRef: (input: Parameters<GitApi["createRef"]>[0]) => Promise<unknown>
    }
  }
}
type OctokitProvider = (installationId: number) => Promise<QrspiOctokit>
type TrustedPublicationVerifier = (
  input: {
    readonly repository: RepositoryReference
    readonly headRef: string
    readonly commitSha: string
  } & (
    { readonly jobId: number } | { readonly controllerId: string; readonly operationId: string }
  ),
) => Promise<string | null>

function finalPullRequestObservation(
  repository: RepositoryReference,
  pull: {
    readonly number: number
    readonly draft?: boolean | null
    readonly body?: string | null
    readonly html_url: string
    readonly base: { readonly ref: string }
    readonly head: { readonly ref: string; readonly sha: string }
  },
) {
  const body = pull.body ?? ""
  return {
    reference: { repository, number: pull.number },
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    draft: pull.draft === true,
    body,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    url: pull.html_url,
  }
}

export class GitHubQrspiRepository implements QrspiRepositoryPort {
  constructor(
    private readonly config: QrspiConfig,
    private readonly client: OctokitProvider,
    private readonly isTrustedPublication: TrustedPublicationVerifier = () => Promise.resolve(null),
  ) {}

  readonly inspect: QrspiRepositoryPort["inspect"] = (input) =>
    this.attempt("inspect repository target", async (signal) => {
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      const [repository, branch] = await Promise.all([
        client.rest.repos.get({ owner, repo, request: { signal } }),
        client.rest.repos.getBranch({ owner, repo, branch: input.baseRef, request: { signal } }),
      ])
      const observed = decodeRepository({
        providerInstanceId: this.config.repository.providerInstanceId,
        repositoryId: String(repository.data.id),
        repositoryFullName: repository.data.full_name,
      })
      const sha = Schema.decodeUnknownSync(
        Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)),
      )(branch.data.commit.sha)
      return {
        repository: observed,
        baseRef: input.baseRef,
        baseSha: sha,
        headRepository: observed,
      }
    })

  readonly hasOpenPullRequest: QrspiRepositoryPort["hasOpenPullRequest"] = (input) =>
    this.attempt("check open pull requests", async (signal) => {
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      const pulls = await client.rest.pulls.list({
        ...openPullRequestQuery(owner, repo, input.headRef),
        request: { signal },
      })
      return pulls.data.length > 0
    })

  readonly observeBranch: QrspiRepositoryPort["observeBranch"] = (input) =>
    this.attempt("observe ticket branch", async (signal) => {
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      try {
        const branch = await client.rest.repos.getBranch({
          owner,
          repo,
          branch: input.headRef,
          request: { signal },
        })
        return { sha: branch.data.commit.sha }
      } catch (cause) {
        if (isNotFound(cause)) return null
        throw cause
      }
    })

  readonly observeAcceptedBranch: QrspiRepositoryPort["observeAcceptedBranch"] = (input) =>
    this.attempt("observe accepted ticket branch", async (signal) => {
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      let sha: string
      try {
        const branch = await client.rest.repos.getBranch({
          owner,
          repo,
          branch: input.headRef,
          request: { signal },
        })
        sha = branch.data.commit.sha
      } catch (cause) {
        if (isNotFound(cause)) return { _tag: "Absent" } as const
        throw cause
      }
      if (
        (input.previousTrustedSha === null && sha === input.baseSha) ||
        sha === input.previousTrustedSha
      ) {
        return { _tag: "Accepted", sha } as const
      }
      if (
        input.previousTrustedSha !== null &&
        (await this.isAcceptedHistory(
          client,
          owner,
          repo,
          input.repository,
          input.headRef,
          input.previousTrustedSha,
          sha,
          signal,
        ))
      ) {
        return { _tag: "Accepted", sha } as const
      }
      return { _tag: "UnknownHistory", sha } as const
    })

  readonly createBranch: QrspiRepositoryPort["createBranch"] = (input) =>
    this.attempt("create exact ticket branch", async (signal) => {
      if (input.authority.leaseUntil.getTime() <= Date.now()) {
        throw new Error("WorkflowStart lease expired before repository mutation")
      }
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      if (
        input.authority.leaseUntil.getTime() <=
        Date.now() +
          this.config.repositoryOperationTimeoutMs +
          this.config.operationCompletionMarginMs
      ) {
        throw new Error("WorkflowStart lease cannot cover repository mutation")
      }
      await client.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${input.headRef}`,
        sha: input.expectedBaseSha,
        request: { signal },
      })
      return { sha: input.expectedBaseSha }
    })

  readonly createFinalPullRequest: QrspiRepositoryPort["createFinalPullRequest"] = (input) =>
    this.attempt("create final pull request", async (signal) => {
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      if (client.rest.pulls.create === undefined)
        throw new Error("Pull request creation unavailable")
      const created = await client.rest.pulls.create({
        owner,
        repo,
        base: input.baseRef,
        head: input.headRef,
        title: input.title,
        body: input.body,
        draft: false,
        request: { signal },
      })
      return { repository: input.repository, number: created.data.number }
    })

  readonly observeFinalPullRequest: QrspiRepositoryPort["observeFinalPullRequest"] = (input) =>
    this.attempt("observe final pull request", async (signal) => {
      const { owner, repo } = repositoryName(input.repository)
      const client = await this.client(this.config.installationId)
      const pulls = await client.rest.pulls.list({
        ...openPullRequestQuery(owner, repo, input.headRef),
        base: input.baseRef,
        request: { signal },
      })
      const pull = pulls.data.find(
        ({ base, head, draft, body }) =>
          base.ref === input.baseRef &&
          head.ref === input.headRef &&
          head.sha === input.headSha &&
          draft !== true &&
          createHash("sha256")
            .update(body ?? "")
            .digest("hex") === input.bodySha256,
      )
      if (pull === undefined) return null
      return finalPullRequestObservation(input.repository, pull)
    })

  readonly observeFinalPullRequestReference: QrspiRepositoryPort["observeFinalPullRequestReference"] =
    (reference) =>
      this.attempt("observe final pull request reference", async (signal) => {
        const { owner, repo } = repositoryName(reference.repository)
        const client = await this.client(this.config.installationId)
        if (client.rest.pulls.get === undefined)
          throw new Error("Pull request observation unavailable")
        const pull = await client.rest.pulls.get({
          owner,
          repo,
          pull_number: reference.number,
          request: { signal },
        })
        return finalPullRequestObservation(reference.repository, pull.data)
      })

  private attempt<A>(operation: string, run: (signal: AbortSignal) => Promise<A>) {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => new QrspiRepositoryError({ operation, cause: normalizeError(cause) }),
    }).pipe(
      Effect.timeoutFail({
        duration: this.config.repositoryOperationTimeoutMs,
        onTimeout: () =>
          new QrspiRepositoryError({
            operation,
            cause: new Error(
              `Repository operation timed out after ${this.config.repositoryOperationTimeoutMs}ms`,
            ),
          }),
      }),
    )
  }

  private async isAcceptedHistory(
    client: QrspiOctokit,
    owner: string,
    repo: string,
    repository: RepositoryReference,
    headRef: string,
    previousTrustedSha: string,
    headSha: string,
    signal: AbortSignal,
  ) {
    const visited = new Set<string>()
    let currentSha = headSha
    while (currentSha !== previousTrustedSha) {
      if (client.rest.repos.getCommit === undefined) return false
      if (visited.has(currentSha)) return false
      visited.add(currentSha)
      const response = await client.rest.repos.getCommit({
        owner,
        repo,
        ref: currentSha,
        request: { signal },
      })
      const commit = response.data
      const jobs = [...commit.commit.message.matchAll(/^Workflowd-Job: (\S+)$/gm)]
      const identity = jobs[0]?.[1]
      const legacy = identity === undefined ? undefined : /^([1-9]\d*)$/.exec(identity)
      const qrspi =
        identity === undefined
          ? undefined
          : /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(.+)$/i.exec(
              identity,
            )
      const jobId = Number(legacy?.[1])
      if (
        commit.sha !== currentSha ||
        commit.parents.length !== 1 ||
        jobs.length !== 1 ||
        (legacy == null && qrspi == null) ||
        (legacy != null && !Number.isSafeInteger(jobId)) ||
        commit.commit.verification?.verified !== true
      ) {
        return false
      }
      const expectedParentSha = await this.isTrustedPublication({
        repository,
        headRef,
        ...(legacy == null ? { controllerId: qrspi![1]!, operationId: qrspi![2]! } : { jobId }),
        commitSha: currentSha,
      })
      if (expectedParentSha === null || commit.parents[0]!.sha !== expectedParentSha) return false
      currentSha = expectedParentSha
    }
    return true
  }
}

export function openPullRequestQuery(owner: string, repo: string, headRef: string) {
  return { owner, repo, state: "open" as const, head: `${owner}:${headRef}`, per_page: 2 }
}

function repositoryName(repository: RepositoryReference) {
  const [owner, repo, extra] = repository.repositoryFullName.split("/")
  if (!owner || !repo || extra !== undefined) throw new Error("Invalid repository locator")
  return { owner, repo }
}

const decodeRepository = Schema.decodeUnknownSync(
  Schema.Struct({
    providerInstanceId: Schema.NonEmptyString,
    repositoryId: Schema.NonEmptyString,
    repositoryFullName: Schema.String.pipe(Schema.pattern(/^[^/\s]+\/[^/\s]+$/)),
  }),
)

function isNotFound(cause: unknown) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    (cause as { readonly status?: unknown }).status === 404
  )
}
