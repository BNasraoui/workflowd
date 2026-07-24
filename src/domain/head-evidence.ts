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

const selfCheckNames = new Set(["OpenCode Review", "Workflowd PR Gate"])
const evidencePath = ".workflowd/evidence.json"
const gateSummaryPrefix = "Automated gates did not pass. Reviewer summary: "

export function gateReviewWithHeadEvidence(
  review: ReviewResult,
  evidence: HeadEvidence,
): GatedReview {
  const requiredChecks = evidence.ci.checks.filter((check) => !selfCheckNames.has(check.name))
  const pendingCheck = requiredChecks.find((check) => check.state === "pending")
  if (pendingCheck !== undefined) {
    return { _tag: "Pending", reason: `Required check is pending: ${pendingCheck.name}` }
  }
  if (evidence.sonar.state === "pending") {
    return { _tag: "Pending", reason: "Sonar Automatic Analysis is pending" }
  }
  if (evidence.mergeability.state === "pending") {
    return { _tag: "Pending", reason: "Pull request mergeability is pending" }
  }

  const findings: Array<ReviewFinding> = []
  if (evidence.ci.state !== "available") {
    findings.push({
      severity: "high",
      title: "Required CI evidence is not current",
      body: evidence.ci.reason ?? `CI evidence is ${evidence.ci.state}.`,
      path: evidencePath,
    })
  }
  for (const check of requiredChecks) {
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

  if (evidence.sonar.state === "pass" || evidence.sonar.state === "fail") {
    if (evidence.sonar.headSha !== evidence.headSha) {
      findings.push(sonarUnavailableFinding("Sonar evidence belongs to a different head SHA."))
    } else {
      for (const finding of evidence.sonar.findings.slice(0, 20)) {
        findings.push({
          severity: sonarSeverity(finding.severity),
          title: bounded(`Sonar issue: ${finding.message}`, 200),
          body: bounded(
            `Sonar Automatic Analysis reports an unresolved new issue (${finding.severity}): ${finding.message}${finding.path === undefined ? "" : `\nLocation: ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`}`,
            10_000,
          ),
          path: evidencePath,
        })
      }
      if (evidence.sonar.unresolvedIssueCount > evidence.sonar.findings.length) {
        findings.push(
          sonarUnavailableFinding(
            `Sonar Automatic Analysis reports ${evidence.sonar.unresolvedIssueCount} unresolved new issues.`,
          ),
        )
      }
      if (evidence.sonar.duplicatedNewLinesPercent > 1) {
        findings.push({
          severity: "high",
          title: "Sonar duplicated new lines exceed one percent",
          body: `Sonar reports ${evidence.sonar.duplicatedNewLinesPercent}% duplicated new lines; the maximum is 1%.`,
          path: evidencePath,
        })
      }
    }
  } else {
    findings.push(
      sonarUnavailableFinding(
        ("reason" in evidence.sonar ? evidence.sonar.reason : undefined) ??
          `Sonar Automatic Analysis evidence is ${evidence.sonar.state}.`,
      ),
    )
  }

  if (evidence.mergeability.state === "conflicting") {
    findings.push({
      severity: "high",
      title: "Pull request has merge conflicts",
      body: "GitHub confirms that the exact review target conflicts with its base. Resolve the conflicts before approval.",
      path: evidencePath,
    })
  } else if (evidence.mergeability.state === "unavailable") {
    findings.push({
      severity: "high",
      title: "Pull request mergeability is unavailable",
      body: evidence.mergeability.reason,
      path: evidencePath,
    })
  }

  if (findings.length === 0) return { _tag: "Ready", review }
  const agentFindings = review.verdict === "changes_requested" ? review.findings : []
  return {
    _tag: "Ready",
    review: {
      verdict: "changes_requested",
      summary: bounded(`${gateSummaryPrefix}${review.summary}`, 4_000),
      findings: [...findings, ...agentFindings].slice(0, 50),
    },
  }
}

export function sanitizeUntrustedText(value: string, maxLength: number): string {
  const sanitized = value
    // CI logs are untrusted terminal output, so these expressions intentionally remove controls.
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g"), "")
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g"), "")
    .replace(
      /\b(authorization\s*:\s*(?:bearer|basic|token)|(?:github|sonar|api)[_-]?token\s*[=:])\s*[^\s]+/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:])\s*[^\s]+/gi,
      "$1 [REDACTED]",
    )
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@]+@/gi, "$1[REDACTED]@")
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
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
