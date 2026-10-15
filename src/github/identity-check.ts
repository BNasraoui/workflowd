import { Effect, Schema } from "effect"
import type { IdentityPublication } from "./identity-publication"
import type { IdentityRequest } from "./identity-request"
import type { IdentityWork } from "./identity-work"
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
const Suite = Schema.Struct({
  check_suite: Schema.Struct({
    id: Id,
    app: Schema.Struct({ id: Id }),
    head_sha: Sha,
  }),
})
const BaseChange = Schema.Struct({ changes: Schema.Struct({ base: Schema.Unknown }) })
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

const targetFromCheck = Effect.fn("GitIdentity.rerunTarget")(function* (
  appId: number,
  envelope: typeof Envelope.Type,
  check: typeof Rerun.Type.check_run,
) {
  if (check.app.id !== appId || check.name !== checkName || check.external_id === null) return []
  const match = /^agent-git:([1-9][0-9]*)$/.exec(check.external_id)
  if (match === null) return []
  const number = yield* Schema.decodeUnknownEffect(Id)(Number(match[1]))
  return [{ ...envelope, number, head: check.head_sha, checkId: check.id }]
})

const targetFromEvent = Effect.fn("GitIdentity.target")(function* (
  appId: number,
  getClient: (installationId: number) => Promise<GitHubInstallationAdapter>,
  event: string,
  payload: unknown,
  attempt: IdentityRequest,
) {
  if (event !== "pull_request" && event !== "check_run" && event !== "check_suite") return []
  const envelope = yield* Schema.decodeUnknownEffect(Envelope)(payload)
  if (event === "pull_request") {
    if (!["opened", "synchronize", "reopened", "edited"].includes(envelope.action)) return []
    if (envelope.action === "edited" && !Schema.is(BaseChange)(payload)) return []
    const { pull_request: pull } = yield* Schema.decodeUnknownEffect(Pull)(payload)
    return [{ ...envelope, number: pull.number, head: pull.head.sha, checkId: undefined }]
  }
  if (envelope.action !== "rerequested") return []
  if (event === "check_suite") {
    const { check_suite: suite } = yield* Schema.decodeUnknownEffect(Suite)(payload)
    if (suite.app.id !== appId) return []
    const client = yield* attempt(() => getClient(envelope.installation.id))
    const [owner = "", repo = ""] = envelope.repository.full_name.split("/")
    // Fork suites may omit pull_requests. Recover our PR identifiers from the
    // existing checks, selecting only this suite and App on its immutable head.
    const checks = []
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    const checkPages = client.listCheckRunPages({
      owner,
      repo,
      ref: suite.head_sha,
      check_name: checkName,
      filter: "all",
      per_page: 100,
      request: { signal: controller.signal },
    })
    const pages = checkPages[Symbol.asyncIterator]()
    for (;;) {
      const page = yield* attempt(() => pages.next(), envelope.installation.id)
      if (page.done) break
      for (const check of page.value) {
        if (check.checkSuiteId === suite.id && check.appId === appId && check.name === checkName)
          checks.push({
            id: check.id,
            name: check.name,
            app: { id: check.appId },
            external_id: check.externalId ?? null,
            head_sha: suite.head_sha,
          })
      }
    }
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Rerun.fields.check_run))(checks)
    const targets = yield* Effect.forEach(decoded, (check) =>
      targetFromCheck(appId, envelope, check),
    )
    return targets.flat()
  }
  const { check_run: check } = yield* Schema.decodeUnknownEffect(Rerun)(payload)
  return yield* targetFromCheck(appId, envelope, check)
}, Effect.scoped)

type Target = Effect.Success<ReturnType<typeof targetFromEvent>>[number]
type Repository = { readonly owner: string; readonly repo: string }

const inspectRange = Effect.fn("GitIdentity.inspectRange")(function* (
  client: GitHubInstallationAdapter,
  repository: Repository,
  base: string,
  head: string,
  blockedEmails: ReadonlyArray<string>,
  attempt: IdentityRequest,
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
    if (data.total_commits > 10_000 || seen.size + data.commits.length > 10_000)
      return yield* Effect.fail(new Error("range too large"))
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
  attempt: IdentityRequest,
) {
  if (!blockedEmails?.some((email) => email.trim().length > 0))
    return yield* Effect.fail(unavailable())
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
  const result = yield* inspectRange(
    client,
    repository,
    pull.baseSha,
    pull.headSha,
    blockedEmails,
    attempt,
  )
  const current = yield* snapshot()
  if (
    current.headSha !== pull.headSha ||
    current.baseSha !== pull.baseSha ||
    current.state !== "open"
  )
    return yield* Effect.fail(unavailable())
  return result
})

const checkTarget = Effect.fn("GitIdentity.checkTarget")(
  function* (
    getClient: (installationId: number) => Promise<GitHubInstallationAdapter>,
    blockedEmails: ReadonlyArray<string> | undefined,
    target: Target,
    publication: IdentityPublication,
    attempt: IdentityRequest,
  ) {
    const [owner = "", repo = ""] = target.repository.full_name.split("/")
    const repository = { owner, repo }
    const prKey = `${target.repository.full_name.toLowerCase()}/${target.number}`
    const installationId = target.installation.id
    const client = yield* attempt(() => getClient(target.installation.id))
    const pending = {
      ...repository,
      name: checkName,
      status: "in_progress" as const,
      external_id: `agent-git:${target.number}`,
      output: { title: checkName, summary: "Inspecting commit identities." },
    }
    const checkId =
      target.checkId ??
      (yield* attempt(
        (signal) =>
          client.createCheckRun({ ...pending, head_sha: target.head, request: { signal } }),
        installationId,
        { kind: "start", prKey },
      ))
    const write = yield* publication(
      `${target.repository.full_name.toLowerCase()}/${checkId}`,
      attempt,
    )
    yield* Effect.gen(function* () {
      if (target.checkId !== undefined)
        yield* write(
          (signal) =>
            client.updateCheckRun({ ...pending, check_run_id: checkId, request: { signal } }),
          installationId,
          { kind: "start", prKey },
        )
      const scan: IdentityRequest = (run) => attempt(run, installationId, { prKey })
      const result = yield* inspectPull(client, repository, target, blockedEmails, scan).pipe(
        Effect.timeout("2 minutes"),
        Effect.catch((error) =>
          Effect.succeed({
            conclusion: "failure" as const,
            output: {
              title: checkName,
              summary:
                error instanceof Error &&
                (error.message === "range too large" ||
                  error.message === "scan budget exhausted, retry later")
                  ? error.message
                  : "Commit identities could not be verified. Re-run this check after resolving the service or policy configuration error.",
            },
          }),
        ),
      )
      yield* write(
        (signal) =>
          client.updateCheckRun({
            ...repository,
            check_run_id: checkId,
            status: "completed",
            ...result,
            request: { signal },
          }),
        installationId,
        { kind: "finish", prKey },
      )
    }).pipe(
      Effect.onInterrupt(() =>
        write(
          (signal) =>
            client.updateCheckRun({
              ...repository,
              check_run_id: checkId,
              status: "completed",
              conclusion: "failure",
              output: { title: checkName, summary: "Superseded by a newer identity check." },
              request: { signal },
            }),
          installationId,
          { kind: "finish", prKey },
        ).pipe(
          Effect.catch(() =>
            Effect.logError("Git identity interrupted check completion unavailable", { checkId }),
          ),
        ),
      ),
    )
  },
  Effect.scoped,
  Effect.catchIf(
    (error) => error instanceof Error && error.message === "scan budget exhausted, retry later",
    () => Effect.logWarning("Git identity check write budget exhausted; delivery dropped"),
  ),
)

export const checkAgentGitIdentity = Effect.fn("GitIdentity.check")(function* (
  appId: number,
  getClient: (installationId: number) => Promise<GitHubInstallationAdapter>,
  blockedEmails: ReadonlyArray<string> | undefined,
  event: string,
  payload: unknown,
  publication: IdentityPublication,
  attempt: IdentityRequest,
) {
  const targets = yield* targetFromEvent(appId, getClient, event, payload, attempt).pipe(
    Effect.mapError(unavailable),
  )
  yield* Effect.forEach(
    targets,
    (target) => checkTarget(getClient, blockedEmails, target, publication, attempt),
    {
      discard: true,
    },
  )
})

export const identityCheckJobs = Effect.fn("GitIdentity.jobs")(function* (
  appId: number,
  getClient: (installationId: number) => Promise<GitHubInstallationAdapter>,
  blockedEmails: ReadonlyArray<string> | undefined,
  event: string,
  payload: unknown,
  publication: IdentityPublication,
  attempt: IdentityRequest,
) {
  const targets = yield* targetFromEvent(appId, getClient, event, payload, attempt).pipe(
    Effect.mapError(unavailable),
  )
  return targets.map((target): IdentityWork => ({
    key: `${target.repository.full_name.toLowerCase()}/${target.number}/${target.head}`,
    prKey: `${target.repository.full_name.toLowerCase()}/${target.number}`,
    preserve: target.checkId !== undefined,
    run: checkTarget(getClient, blockedEmails, target, publication, attempt),
  }))
})
