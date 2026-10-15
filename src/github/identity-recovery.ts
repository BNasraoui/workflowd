import { Effect, Schema } from "effect"
import type { PrRepositories } from "../pr-automation-config"
import type { GitHubCheckRun, GitHubInstallationAdapter } from "./adapter"
import type { IdentityRequest } from "./identity-request"
import type { IdentityPublication } from "./identity-publication"

const Pulls = Schema.Array(
  Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    head: Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) }),
  }),
)

type Dispatch = (event: string, payload: unknown) => Effect.Effect<void, Error>

// Stream one API page at a time; discovery never accumulates an installation's
// open PRs or checks in memory. Individual repository failures remain isolated.
export const recoverIdentityChecks = Effect.fn("GitIdentity.recover")(function* (
  appId: number,
  getClient: (installationId: number) => Promise<GitHubInstallationAdapter>,
  request: IdentityRequest,
  repositories: PrRepositories,
  dispatch: Dispatch,
  publication: IdentityPublication,
) {
  for (const repository of repositories) {
    yield* Effect.gen(function* () {
      const client = yield* request(() => getClient(repository.installationId))
      const [owner = "", repo = ""] = repository.repository.split("/")
      const list = client.listOpenPullPages?.bind(client)
      if (list === undefined)
        return yield* Effect.fail(new Error("Pull request listing unavailable"))
      // The controller also closes async pagination on daemon shutdown.
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const pulls = list({
        owner,
        repo,
        state: "open",
        per_page: 100,
        request: { signal: controller.signal },
      })[Symbol.asyncIterator]()
      for (;;) {
        const page = yield* request(() => pulls.next(), repository.installationId)
        if (page.done) break
        for (const pull of yield* Schema.decodeUnknownEffect(Pulls)(page.value)) {
          const checkPages = client.listCheckRunPages({
            owner,
            repo,
            ref: pull.head.sha,
            check_name: "Workflowd Git Identity",
            filter: "all",
            per_page: 100,
            request: { signal: controller.signal },
          })
          const checks = checkPages[Symbol.asyncIterator]()
          let newest: GitHubCheckRun | undefined
          for (;;) {
            const page = yield* request(() => checks.next(), repository.installationId, {
              prKey: `${repository.repository.toLowerCase()}/${pull.number}`,
            })
            if (page.done) break
            for (const check of page.value) {
              if (
                check.appId !== appId ||
                check.name !== "Workflowd Git Identity" ||
                check.status !== "in_progress" ||
                check.externalId !== `agent-git:${pull.number}`
              )
                continue
              if (newest === undefined) {
                newest = check
                continue
              }
              const older = check.id > newest.id ? newest : check
              if (check.id > newest.id) newest = check
              yield* Effect.gen(function* () {
                const write = yield* publication(
                  `${repository.repository.toLowerCase()}/${older.id}`,
                  request,
                )
                yield* write(
                  (signal) =>
                    client.updateCheckRun({
                      owner,
                      repo,
                      check_run_id: older.id,
                      status: "completed",
                      conclusion: "failure",
                      output: {
                        title: "Workflowd Git Identity",
                        summary: "Superseded by a newer identity check on this head.",
                      },
                      request: { signal },
                    }),
                  repository.installationId,
                  {
                    kind: "finish",
                    prKey: `${repository.repository.toLowerCase()}/${pull.number}`,
                  },
                )
              }).pipe(
                Effect.scoped,
                Effect.catch(() =>
                  Effect.logError("Git identity supersede unavailable", {
                    repository: repository.repository,
                    checkId: older.id,
                  }),
                ),
              )
            }
          }
          if (newest !== undefined) {
            yield* dispatch("check_run", {
              action: "rerequested",
              installation: { id: repository.installationId },
              repository: { full_name: repository.repository },
              check_run: {
                id: newest.id,
                name: newest.name,
                app: { id: appId },
                external_id: newest.externalId,
                head_sha: pull.head.sha,
              },
            })
          }
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.catch(() =>
        Effect.logError("Git identity startup recovery unavailable; redeliver webhook"),
      ),
    )
  }
})
