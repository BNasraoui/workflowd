import { Effect, Schema } from "effect"
import { sanitizeUntrustedText, type SonarEvidence } from "../domain/head-evidence"
import type { SonarRequest } from "./head-evidence"

/**
 * Runs one cancellable Sonar request. The caller supplies it so this module
 * carries no opinion about how a failed GitHub-side request is reported.
 */
export type EvidenceAttempt<E> = <A>(
  operation: string,
  run: (signal: AbortSignal) => Promise<A>,
) => Effect.Effect<A, E>

export type SonarCollectionInput = {
  readonly pullRequestNumber: number
  readonly sonarRequest: SonarRequest
  readonly target: { readonly headSha: string }
}

const SonarPullRequests = Schema.Struct({
  pullRequests: Schema.Array(
    Schema.Struct({ key: Schema.String, commit: Schema.Struct({ sha: Schema.String }) }),
  ),
})
const SonarIssues = Schema.Struct({
  paging: Schema.Struct({ total: Schema.Number }),
  issues: Schema.Array(
    Schema.Struct({
      severity: Schema.optional(Schema.String),
      message: Schema.String,
      component: Schema.optional(Schema.String),
      line: Schema.optional(Schema.Number),
    }),
  ),
})
const SonarMeasures = Schema.Struct({
  component: Schema.Struct({
    measures: Schema.Array(
      Schema.Struct({
        metric: Schema.String,
        periods: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String }))),
      }),
    ),
  }),
})

export function collectSonar<E>(
  input: SonarCollectionInput,
  project: string,
  attempt: EvidenceAttempt<E>,
): Effect.Effect<SonarEvidence, E> {
  return Effect.gen(function* () {
    const pullRequest = String(input.pullRequestNumber)
    const listPath = `/api/project_pull_requests/list?project=${encodeURIComponent(project)}`
    const first = yield* sonarJson(attempt, input.sonarRequest, listPath, SonarPullRequests)
    const analyzed = first.pullRequests.find((candidate) => candidate.key === pullRequest)
    if (analyzed === undefined) {
      return { state: "missing", reason: "No public Sonar PR analysis is available." }
    }
    if (analyzed.commit.sha !== input.target.headSha) {
      return {
        state: "stale",
        reason: `Sonar analyzed ${analyzed.commit.sha}, not ${input.target.headSha}.`,
      }
    }

    const issues = yield* sonarJson(
      attempt,
      input.sonarRequest,
      `/api/issues/search?componentKeys=${encodeURIComponent(project)}&pullRequest=${encodeURIComponent(pullRequest)}&resolved=false&ps=100`,
      SonarIssues,
    )
    if (!Number.isInteger(issues.paging.total) || issues.paging.total < 0) {
      return { state: "unavailable", reason: "Sonar issue count is invalid." }
    }
    const measures = yield* sonarJson(
      attempt,
      input.sonarRequest,
      `/api/measures/component?component=${encodeURIComponent(project)}&pullRequest=${encodeURIComponent(pullRequest)}&metricKeys=new_duplicated_lines_density`,
      SonarMeasures,
    )
    const duplication = measures.component.measures.find(
      (measure) => measure.metric === "new_duplicated_lines_density",
    )?.periods?.[0]?.value
    if (
      duplication === undefined ||
      !Number.isFinite(Number(duplication)) ||
      Number(duplication) < 0
    ) {
      return { state: "unavailable", reason: "Sonar new-code duplication measure is unavailable." }
    }

    const second = yield* sonarJson(attempt, input.sonarRequest, listPath, SonarPullRequests)
    const confirmed = second.pullRequests.find((candidate) => candidate.key === pullRequest)
    if (confirmed?.commit.sha !== input.target.headSha) {
      return { state: "stale", reason: "Sonar PR analysis changed during evidence collection." }
    }
    const findings = issues.issues.slice(0, 20).map((issue) => ({
      severity: issue.severity ?? "unknown",
      message: sanitizeUntrustedText(issue.message, 1_000),
      ...(issue.component === undefined
        ? {}
        : { path: issue.component.replace(`${project}:`, "").slice(0, 1_024) }),
      ...(issue.line === undefined ? {} : { line: Math.max(1, Math.trunc(issue.line)) }),
    }))
    const duplicatedNewLinesPercent = Number(duplication)
    return {
      state: issues.paging.total === 0 && duplicatedNewLinesPercent <= 1 ? "pass" : "fail",
      headSha: input.target.headSha,
      unresolvedIssueCount: issues.paging.total,
      duplicatedNewLinesPercent,
      findings,
    }
  })
}

export function passingSonarEvidence(headSha: string): SonarEvidence {
  return {
    state: "pass",
    headSha,
    unresolvedIssueCount: 0,
    duplicatedNewLinesPercent: 0,
    findings: [],
  }
}

function sonarJson<A, I, E>(
  attempt: EvidenceAttempt<E>,
  request: SonarRequest,
  path: string,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, E> {
  return attempt(`read public Sonar endpoint ${path.split("?", 1)[0]}`, async (signal) => {
    const response = await request(path, signal)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sonar returned HTTP ${response.status}`)
    }
    return Schema.decodeUnknownSync(schema)(response.body)
  })
}
