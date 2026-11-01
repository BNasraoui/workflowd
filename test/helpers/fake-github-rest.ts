/** A Bun.serve fake of the GitHub REST endpoints head evidence reads. */

export type FakeCheckRun = {
  readonly id: number
  readonly name: string
  readonly conclusion: string
  readonly appId: number
  readonly appSlug: string
  readonly checkSuiteId?: number
}

export type FakeWorkflowRun = {
  readonly id: number
  readonly workflowId: number
  readonly path: string
  readonly checkSuiteId: number
}

export type FakeRepository = {
  readonly baseRef: string
  readonly baseSha: string
  readonly headRef: string
  readonly headSha: string
  /** Required status checks of the base branch's rules, or the HTTP status its read fails with. */
  readonly rules:
    ReadonlyArray<{ readonly context: string; readonly integrationId?: number }> | number
  readonly checkRuns: ReadonlyArray<FakeCheckRun>
  readonly statuses?: ReadonlyArray<{ readonly context: string; readonly state: string }>
  readonly workflows?: Readonly<Record<string, number>>
  /** Blob SHAs keyed by `path@ref`. */
  readonly contents?: Readonly<Record<string, string>>
  readonly workflowRuns?: ReadonlyArray<FakeWorkflowRun>
}

export type FakeGitHubRest = {
  readonly url: string
  readonly requests: ReadonlyArray<string>
  readonly stop: () => Promise<void>
}

export function startFakeGitHubRest(
  repositories: Readonly<Record<string, FakeRepository>>,
): FakeGitHubRest {
  const requests: Array<string> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      const match = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname)
      const fullName = match === null ? undefined : `${match[1]}/${match[2]}`
      const repository = fullName === undefined ? undefined : repositories[fullName]
      if (match === null || fullName === undefined || repository === undefined) {
        return notFound()
      }
      return route(fullName, repository, decodeURIComponent(match[3] ?? ""), url)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

function route(fullName: string, repository: FakeRepository, path: string, url: URL): Response {
  const [owner, name] = fullName.split("/")
  if (/^pulls\/\d+$/.test(path)) {
    return json({
      number: Number(path.split("/")[1]),
      user: { login: "author" },
      author_association: "OWNER",
      base: {
        ref: repository.baseRef,
        sha: repository.baseSha,
        repo: { id: 1, full_name: fullName, name, owner: { login: owner } },
      },
      draft: false,
      head: { ref: repository.headRef, sha: repository.headSha, repo: { full_name: fullName } },
      state: "open",
      mergeable: true,
      mergeable_state: "clean",
    })
  }
  if (path === `rules/branches/${repository.baseRef}`) {
    if (typeof repository.rules === "number") {
      return json({ message: "fake rules failure" }, repository.rules)
    }
    return json([
      { type: "deletion", ruleset_id: 1 },
      {
        type: "required_status_checks",
        ruleset_id: 2,
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: repository.rules.map((rule) => ({
            context: rule.context,
            ...(rule.integrationId === undefined ? {} : { integration_id: rule.integrationId }),
          })),
        },
      },
    ])
  }
  if (path === `commits/${repository.headSha}/check-runs`) {
    return json({
      total_count: repository.checkRuns.length,
      check_runs: repository.checkRuns.map((check) => ({
        id: check.id,
        name: check.name,
        status: "completed",
        conclusion: check.conclusion,
        details_url: `https://github.test/checks/${check.id}`,
        output: { summary: null },
        app: { id: check.appId, slug: check.appSlug },
        ...(check.checkSuiteId === undefined ? {} : { check_suite: { id: check.checkSuiteId } }),
      })),
    })
  }
  if (path === `commits/${repository.headSha}/statuses`) {
    return json(
      (repository.statuses ?? []).map((status) => ({
        context: status.context,
        state: status.state,
        description: null,
        target_url: null,
      })),
    )
  }
  if (path === "actions/runs") {
    const runs = (repository.workflowRuns ?? []).filter(
      () => url.searchParams.get("head_sha") === repository.headSha,
    )
    return json({
      total_count: runs.length,
      workflow_runs: runs.map((run) => ({
        id: run.id,
        name: "CI",
        head_sha: repository.headSha,
        status: "completed",
        conclusion: "success",
        workflow_id: run.workflowId,
        path: run.path,
        check_suite_id: run.checkSuiteId,
      })),
    })
  }
  if (/^actions\/runs\/\d+\/jobs$/.test(path)) return json({ total_count: 0, jobs: [] })
  if (path.startsWith("actions/workflows/")) {
    const workflowPath = path.slice("actions/workflows/".length)
    const id = repository.workflows?.[workflowPath]
    return id === undefined ? notFound() : json({ id, path: workflowPath })
  }
  if (path.startsWith("contents/")) {
    const sha =
      repository.contents?.[`${path.slice("contents/".length)}@${url.searchParams.get("ref")}`]
    return sha === undefined ? notFound() : json({ type: "file", sha })
  }
  return notFound()
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function notFound(): Response {
  return json({ message: "Not Found" }, 404)
}
