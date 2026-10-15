import { Effect, Schema } from "effect"
import type { GitHubInstallationAdapter } from "./adapter"

const checkName = "Workflowd Git Identity"
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Id = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Envelope = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({ id: Id }),
  repository: Schema.Struct({
    full_name: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  }),
})
const Pull = Schema.Struct({
  pull_request: Schema.Struct({ number: Id, head: Schema.Struct({ sha: Sha }) }),
})
const Rerun = Schema.Struct({
  check_run: Schema.Struct({
    id: Id,
    name: Schema.String,
    app: Schema.Struct({ id: Id }),
    external_id: Schema.NullOr(Schema.String),
    head_sha: Sha,
  }),
})
const Comparison = Schema.Struct({
  total_commits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  commits: Schema.Array(
    Schema.Struct({
      sha: Sha,
      commit: Schema.Struct({
        author: Schema.Struct({ email: Schema.String }),
        committer: Schema.Struct({ email: Schema.String }),
      }),
    }),
  ),
})
const Snapshot = Schema.Struct({
  pullRequest: Schema.Struct({
    number: Id,
    headSha: Sha,
    baseSha: Sha,
    state: Schema.Literals(["open", "closed"]),
  }),
})

const unavailable = () => new Error("Git identity check unavailable")
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: unavailable }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(unavailable),
  )

const targetFromEvent = Effect.fn("GitIdentity.target")(function* (
  appId: number,
  event: string,
  payload: unknown,
) {
  if (event !== "pull_request" && event !== "check_run") return
  const envelope = yield* Schema.decodeUnknownEffect(Envelope)(payload)
  if (event === "pull_request") {
    if (!["opened", "synchronize", "reopened", "edited"].includes(envelope.action)) return
    const { pull_request: pull } = yield* Schema.decodeUnknownEffect(Pull)(payload)
    return { ...envelope, number: pull.number, head: pull.head.sha, checkId: undefined }
  }
  if (envelope.action !== "rerequested") return
  const { check_run: check } = yield* Schema.decodeUnknownEffect(Rerun)(payload)
  if (check.app.id !== appId || check.name !== checkName || check.external_id === null) return
  const match = /^agent-git:([1-9][0-9]*)$/.exec(check.external_id)
  if (match === null) return
  const number = yield* Schema.decodeUnknownEffect(Id)(Number(match[1]))
  return { ...envelope, number, head: check.head_sha, checkId: check.id }
})

type Target = NonNullable<Effect.Success<ReturnType<typeof targetFromEvent>>>
type Repository = { readonly owner: string; readonly repo: string }

const inspectRange = Effect.fn("GitIdentity.inspectRange")(function* (
  client: GitHubInstallationAdapter,
  repository: Repository,
  base: string,
  head: string,
  blockedEmails: ReadonlyArray<string>,
) {
  const compareCommits = client.compareCommits?.bind(client)
  if (compareCommits === undefined) return yield* Effect.fail(unavailable())
  const blocked = new Set(blockedEmails.map((value) => value.trim().toLowerCase()))
  const seen = new Set<string>()
  const failures: Array<string> = []
  let total: number | undefined
  for (let page = 1; total === undefined || seen.size < total; page++) {
    const data = yield* attempt((signal) =>
      compareCommits({
        ...repository,
        basehead: `${base}...${head}`,
        per_page: 100,
        page,
        request: { signal },
      }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Comparison)))
    if (
      (total !== undefined && total !== data.total_commits) ||
      (data.commits.length === 0 && seen.size < data.total_commits)
    )
      return yield* Effect.fail(unavailable())
    total = data.total_commits
    for (const entry of data.commits) {
      if (seen.has(entry.sha)) return yield* Effect.fail(unavailable())
      seen.add(entry.sha)
      const roles = (["author", "committer"] as const).filter((role) =>
        blocked.has(entry.commit[role].email.trim().toLowerCase()),
      )
      if (roles.length > 0) failures.push(`${entry.sha}: ${roles.join(", ")}`)
    }
  }
  if (seen.size !== total) return yield* Effect.fail(unavailable())
  // GitHub limits a check summary to 65535 characters. Never truncate a SHA/role line.
  const lines = failures.slice(0, 900)
  if (failures.length > lines.length)
    lines.push(`${failures.length - lines.length} additional failing commits omitted.`)
  return {
    conclusion: failures.length ? ("failure" as const) : ("success" as const),
    output: {
      title: checkName,
      summary: failures.length ? lines.join("\n") : "All commit identities passed.",
    },
  }
})

const inspectPull = Effect.fn("GitIdentity.inspectPull")(function* (
  client: GitHubInstallationAdapter,
  repository: Repository,
  target: Target,
  blockedEmails: ReadonlyArray<string> | undefined,
) {
  if (blockedEmails === undefined) return yield* Effect.fail(unavailable())
  const snapshot = () =>
    attempt((signal) =>
      client.getPullRequest({
        ...repository,
        pull_number: target.number,
        request: { signal },
      }),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      Effect.map((data) => data.pullRequest),
    )
  const pull = yield* snapshot()
  if (pull.number !== target.number || pull.headSha !== target.head || pull.state !== "open")
    return yield* Effect.fail(unavailable())
  const result = yield* inspectRange(client, repository, pull.baseSha, pull.headSha, blockedEmails)
  const current = yield* snapshot()
  if (
    current.headSha !== pull.headSha ||
    current.baseSha !== pull.baseSha ||
    current.state !== "open"
  )
    return yield* Effect.fail(unavailable())
  return result
})

export const checkAgentGitIdentity = Effect.fn("GitIdentity.check")(function* (
  appId: number,
  getClient: (installationId: number) => Promise<GitHubInstallationAdapter>,
  blockedEmails: ReadonlyArray<string> | undefined,
  event: string,
  payload: unknown,
) {
  const target = yield* targetFromEvent(appId, event, payload).pipe(Effect.mapError(unavailable))
  if (target === undefined) return
  const [owner = "", repo = ""] = target.repository.full_name.split("/")
  const repository = { owner, repo }
  const client = yield* attempt(() => getClient(target.installation.id))
  const pending = {
    ...repository,
    name: checkName,
    status: "in_progress" as const,
    external_id: `agent-git:${target.number}`,
    output: { title: checkName, summary: "Inspecting commit identities." },
  }
  const checkId = yield* attempt((signal) =>
    target.checkId === undefined
      ? client.createCheckRun({ ...pending, head_sha: target.head, request: { signal } })
      : client.updateCheckRun({ ...pending, check_run_id: target.checkId, request: { signal } }),
  )
  const result = yield* inspectPull(client, repository, target, blockedEmails).pipe(
    Effect.timeout("2 minutes"),
    Effect.catch(() =>
      Effect.succeed({
        conclusion: "failure" as const,
        output: {
          title: checkName,
          summary:
            "Commit identities could not be verified. Re-run this check after resolving the service or policy configuration error.",
        },
      }),
    ),
  )
  yield* attempt((signal) =>
    client.updateCheckRun({
      ...repository,
      check_run_id: checkId,
      status: "completed",
      ...result,
      request: { signal },
    }),
  )
})
