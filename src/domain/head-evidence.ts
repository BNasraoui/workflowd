import type { ReviewFinding, ReviewResult } from "./review-result"

export type CheckEvidence = {
  readonly name: string
  readonly state: "success" | "failure" | "pending"
  readonly conclusion?: string
  readonly detailsUrl?: string
  readonly summary?: string
  readonly log?: string
}

export type CiEvidence = {
  readonly state: "available" | "unavailable" | "stale"
  readonly reason?: string
  readonly checks: ReadonlyArray<CheckEvidence>
}

export type SonarFinding = {
  readonly severity: string
  readonly message: string
  readonly path?: string
  readonly line?: number
}

export type SonarEvidence =
  | {
      readonly state: "pass" | "fail"
      readonly headSha: string
      readonly unresolvedIssueCount: number
      readonly duplicatedNewLinesPercent: number
      readonly findings: ReadonlyArray<SonarFinding>
    }
  | {
      readonly state: "pending" | "missing" | "stale" | "unavailable" | "failed"
      readonly reason?: string
    }

export type MergeabilityEvidence =
  | { readonly state: "mergeable" | "conflicting" | "pending" }
  | { readonly state: "unavailable"; readonly reason: string }

export type HeadEvidence = {
  readonly headSha: string
  readonly ci: CiEvidence
  readonly sonar: SonarEvidence
  readonly mergeability: MergeabilityEvidence
}

export type GatedReview =
  | { readonly _tag: "Pending"; readonly reason: string }
  | { readonly _tag: "Ready"; readonly review: ReviewResult }

export const repositoryRequiredCheckContexts = [
  "Required checks",
  "SonarCloud Code Analysis",
  "CodeQL (JavaScript/TypeScript)",
] as const
const evidencePath = ".workflowd/evidence.json"
const gateSummaryPrefix = "Automated gates did not pass. Reviewer summary: "

export function gateReviewWithHeadEvidence(
  review: ReviewResult,
  evidence: HeadEvidence,
): GatedReview {
  const pending = pendingReason(evidence.ci.checks, evidence)
  if (pending !== undefined) return { _tag: "Pending", reason: pending }
  const findings = [
    ...ciFindings(evidence.ci),
    ...sonarFindings(evidence),
    ...mergeabilityFindings(evidence.mergeability),
  ]
  if (findings.length === 0) return { _tag: "Ready", review }
  const agentFindings = review.verdict === "changes_requested" ? review.findings : []
  const retainedGateFindings = findings.slice(0, Math.max(0, 50 - agentFindings.length))
  return {
    _tag: "Ready",
    review: {
      verdict: "changes_requested",
      summary: bounded(`${gateSummaryPrefix}${review.summary}`, 4_000),
      findings: [...retainedGateFindings, ...agentFindings],
    },
  }
}

function pendingReason(
  checks: ReadonlyArray<CheckEvidence>,
  evidence: HeadEvidence,
): string | undefined {
  const pendingCheck = checks.find((check) => check.state === "pending")
  if (pendingCheck !== undefined) return `Required check is pending: ${pendingCheck.name}`
  if (evidence.sonar.state === "pending") return "Sonar Automatic Analysis is pending"
  return evidence.mergeability.state === "pending"
    ? "Pull request mergeability is pending"
    : undefined
}

function ciFindings(ci: CiEvidence): Array<ReviewFinding> {
  const findings: Array<ReviewFinding> = []
  if (ci.state !== "available") {
    findings.push({
      severity: "high",
      title: "Required CI evidence is not current",
      body: ci.reason ?? `CI evidence is ${ci.state}.`,
      path: evidencePath,
    })
  }
  for (const check of ci.checks) {
    if (check.state !== "failure") continue
    const details = [
      `Conclusion: ${check.conclusion ?? "non-success"}.`,
      check.detailsUrl === undefined ? undefined : `Details: ${check.detailsUrl}`,
      check.summary,
      check.log === undefined ? undefined : `Untrusted log excerpt:\n${check.log}`,
    ].filter((value): value is string => value !== undefined && value !== "")
    findings.push({
      severity: "high",
      title: bounded(`Required check did not succeed: ${check.name}`, 200),
      body: bounded(details.join("\n\n"), 10_000),
      path: evidencePath,
    })
  }
  return findings
}

function sonarFindings(evidence: HeadEvidence): Array<ReviewFinding> {
  const sonar = evidence.sonar
  if (sonar.state !== "pass" && sonar.state !== "fail") {
    const reason = "reason" in sonar ? sonar.reason : undefined
    return [
      sonarUnavailableFinding(reason ?? `Sonar Automatic Analysis evidence is ${sonar.state}.`),
    ]
  }
  if (sonar.headSha !== evidence.headSha) {
    return [sonarUnavailableFinding("Sonar evidence belongs to a different head SHA.")]
  }
  const findings = sonar.findings.slice(0, 20).map(sonarReviewFinding)
  if (sonar.unresolvedIssueCount > sonar.findings.length) {
    findings.push(
      sonarUnavailableFinding(
        `Sonar Automatic Analysis reports ${sonar.unresolvedIssueCount} unresolved new issues.`,
      ),
    )
  }
  if (sonar.duplicatedNewLinesPercent > 1) {
    findings.push({
      severity: "high",
      title: "Sonar duplicated new lines exceed one percent",
      body: `Sonar reports ${sonar.duplicatedNewLinesPercent}% duplicated new lines; the maximum is 1%.`,
      path: evidencePath,
    })
  }
  return findings
}

function sonarReviewFinding(finding: SonarFinding): ReviewFinding {
  const line = finding.line === undefined ? "" : `:${finding.line}`
  const location = finding.path === undefined ? "" : `\nLocation: ${finding.path}${line}`
  return {
    severity: sonarSeverity(finding.severity),
    title: bounded(`Sonar issue: ${finding.message}`, 200),
    body: bounded(
      `Sonar Automatic Analysis reports an unresolved new issue (${finding.severity}): ${finding.message}${location}`,
      10_000,
    ),
    path: evidencePath,
  }
}

function mergeabilityFindings(mergeability: MergeabilityEvidence): Array<ReviewFinding> {
  if (mergeability.state === "conflicting") {
    return [
      {
        severity: "high",
        title: "Pull request has merge conflicts",
        body: "GitHub confirms that the exact review target conflicts with its base. Resolve the conflicts before approval.",
        path: evidencePath,
      },
    ]
  }
  return mergeability.state === "unavailable"
    ? [
        {
          severity: "high",
          title: "Pull request mergeability is unavailable",
          body: mergeability.reason,
          path: evidencePath,
        },
      ]
    : []
}

export function sanitizeUntrustedText(value: string, maxLength: number): string {
  const sanitized = value
    // CI logs are untrusted terminal output, so these expressions intentionally remove controls.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(authorization\s*:\s*(?:bearer|basic|token)|(?:github|sonar|api)[_-]?token\s*[=:])\s*(?:"[\s\S]*?"|'[\s\S]*?'|[^\s]+)/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:])\s*(?:"[\s\S]*?"|'[\s\S]*?'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@]+@/gi, "$1[REDACTED]@")
  if (sanitized.length <= maxLength) return sanitized
  const marker = "\n[truncated by workflowd]"
  return `${sanitized.slice(0, Math.max(0, maxLength - marker.length))}${marker}`
}

export function stripHeadEvidenceFindings(review: ReviewResult): ReviewResult {
  if (review.verdict === "pass") return review
  const findings = review.findings.filter((finding) => finding.path !== evidencePath)
  const summary = review.summary.startsWith(gateSummaryPrefix)
    ? review.summary.slice(gateSummaryPrefix.length)
    : review.summary
  return findings.length === 0
    ? { verdict: "pass", summary, findings: [] }
    : { ...review, summary, findings }
}

function sonarUnavailableFinding(body: string): ReviewFinding {
  return {
    severity: "high",
    title: "Sonar Automatic Analysis did not authorize approval",
    body: bounded(body, 10_000),
    path: evidencePath,
  }
}

function sonarSeverity(severity: string): ReviewFinding["severity"] {
  switch (severity.toLowerCase()) {
    case "blocker":
      return "critical"
    case "critical":
    case "high":
    case "major":
      return "high"
    case "minor":
    case "medium":
      return "medium"
    default:
      return "low"
  }
}

function bounded(value: string, maxLength: number): string {
  return value.slice(0, maxLength)
}
