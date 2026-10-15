import { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { GitHubAppAdapter } from "../../src/github"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "../../src/github/adapter"
export const head = "a".repeat(40)
export const base = "b".repeat(40)
export const blocked = ["blocked", "example.test"].join("@")
export const allowed = ["agent", "example.test"].join("@")
export const checkName = "Workflowd Git Identity"
export const commit = (sha: string, author = allowed, committer = allowed) => ({
  sha,
  commit: { author: { email: author }, committer: { email: committer }, message: blocked },
  author: null,
  committer: null,
})
export const payload = (action = "opened") => ({
  action,
  installation: { id: 91 },
  repository: { full_name: "owner/repo" },
  pull_request: { number: 7, user: { login: "author-7" }, head: { sha: head } },
})

export function fixture(
  options: {
    author?: () => string
    association?: string
    headRepository?: string
    afterSnapshot?: () => Promise<void>
    baseSha?: () => string
    intercept?: (
      path: string,
      body: Record<string, unknown>,
      signal: AbortSignal | null | undefined,
      url: URL,
    ) => Promise<Response | undefined>
    pages?: ReadonlyArray<unknown>
    errorPath?: string
    config?: boolean
    changedHead?: boolean
    changeBaseDuringScan?: boolean
    emptyPolicy?: boolean
    policy?: string[]
    changeHeadDuringScan?: boolean
    closedBefore?: boolean
    closedAfter?: boolean
    wrongNumber?: boolean
    suiteChecks?: ReadonlyArray<Record<string, unknown>>
    failCompletion?: boolean
  } = {},
) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const writes: Array<Record<string, unknown>> = []
  const apiCommits: Array<ReturnType<typeof commit>> = []
  let pulls = 0
  const client = new Octokit({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = init?.method ?? "GET"
        const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        )
        const intercepted = await options.intercept?.(url.pathname, body, init?.signal, url)
        if (intercepted !== undefined) return intercepted
        requests.push({ method, path: url.pathname + url.search, body })
        if (url.pathname.includes(options.errorPath ?? "NEVER"))
          return Response.json({ message: blocked }, { status: 503 })
        if (url.pathname.endsWith("/git/commits")) {
          const identity = Schema.decodeUnknownSync(
            Schema.Struct({
              author: Schema.Struct({ email: Schema.String }),
              committer: Schema.Struct({ email: Schema.String }),
            }),
          )(body)
          const created = commit(head, identity.author.email, identity.committer.email)
          apiCommits.push(created)
          return Response.json(created, { status: 201 })
        }
        if (url.pathname.includes("/check-runs") && method === "GET") {
          const checks =
            options.suiteChecks ??
            [7, 8].map((number) => ({
              id: number + 10,
              name: checkName,
              app: { id: 123 },
              check_suite: { id: 44 },
              external_id: `agent-git:${number}`,
            }))
          const page = Number(url.searchParams.get("page") ?? 1)
          const next = new URL(url)
          next.searchParams.set("page", String(page + 1))
          const response = Response.json(
            { total_count: checks.length, check_runs: checks.slice((page - 1) * 100, page * 100) },
            {
              headers:
                page * 100 < checks.length ? { link: `<${next.toString()}>; rel="next"` } : {},
            },
          )
          Object.defineProperty(response, "url", { value: url.toString() })
          return response
        }
        if (url.pathname.includes("/check-runs")) {
          if (options.failCompletion && method === "PATCH")
            return Response.json({ message: blocked }, { status: 503 })
          writes.push(body)
          return Response.json({ id: 12 }, { status: method === "POST" ? 201 : 200 })
        }
        if (url.pathname.includes("/compare/")) {
          if (
            options.pages !== undefined &&
            options.pages.length <= 2 &&
            Number(url.searchParams.get("page") ?? 1) > 3
          )
            return Response.json({ message: "fixture pagination exhausted" }, { status: 503 })
          const pages = options.pages ?? [
            { total_commits: 1, commits: apiCommits.length ? apiCommits : [commit(head)] },
          ]
          await new Promise((resolve) => setTimeout(resolve, 0))
          return Response.json(
            pages[Math.min(Number(url.searchParams.get("page") ?? 1) - 1, pages.length - 1)],
          )
        }
        if (/\/pulls\/\d+$/.test(url.pathname)) {
          pulls++
          const response = Response.json({
            number: options.wrongNumber ? 8 : Number(url.pathname.split("/").at(-1)),
            user: { login: options.author?.() ?? `author-${url.pathname.split("/").at(-1)}` },
            author_association: options.association ?? "NONE",
            draft: true,
            state:
              (options.closedBefore && pulls === 1) || (options.closedAfter && pulls > 1)
                ? "closed"
                : "open",
            base: {
              ref: "main",
              sha:
                options.baseSha?.() ??
                (options.changeBaseDuringScan && pulls > 1 ? "d".repeat(40) : base),
              repo: { id: 1, full_name: "owner/repo", name: "repo", owner: { login: "owner" } },
            },
            head: {
              ref: "feature",
              sha:
                options.changedHead || (options.changeHeadDuringScan && pulls > 1)
                  ? "c".repeat(40)
                  : head,
              repo: { full_name: options.headRepository ?? "fork/repo" },
            },
          })
          await options.afterSnapshot?.()
          return response
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`)
      },
    },
  })
  const app = new GitHubAppAdapter(
    123,
    async () => new OctokitInstallationAdapter(makeOctokitClientPort(client)),
    undefined,
    undefined,
    options.config === false ? undefined : options.emptyPolicy ? [] : (options.policy ?? [blocked]),
  )
  const run = (event = "pull_request", value: unknown = payload()) =>
    Effect.runPromise(app.checkAgentGitIdentity(event, value).pipe(Effect.timeout("2 seconds")))
  return { app, client, run, writes, requests }
}
