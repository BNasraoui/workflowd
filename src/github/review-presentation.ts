import type { Publication } from "../domain/publication"

const COMMENT_MAX_LENGTH = 65_536
const CHECK_OUTPUT_MAX_LENGTH = 65_535
const TRUNCATION_NOTICE = "\n\n_Output truncated to fit GitHub limits._"

type ReviewCheckPresentation = {
  readonly conclusion: "success" | "action_required"
  readonly output: {
    readonly title: string
    readonly summary: string
    readonly text: string
  }
}

export function reviewMarker(publication: Publication): string {
  return `<!-- workflowd:review:${publication.repositoryId}:${publication.pullRequestNumber} -->`
}

export function renderReviewComment(publication: Publication): string {
  const verdict =
    publication.review.verdict === "pass" ? "No changes requested" : "Changes requested"
  const findings = publication.review.findings
    .map((finding, index) => {
      const location = finding.path
        ? `\n\nLocation: \`${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}\``
        : ""
      return `${index + 1}. **[${finding.severity.toUpperCase()}] ${finding.title}**${location}\n\n${finding.body}`
    })
    .join("\n\n")

  return truncate(
    `${reviewMarker(publication)}
## OpenCode Review

Commit: \`${publication.target.headSha}\`

Verdict: **${verdict}**

${publication.review.summary}

### Findings

${findings || "No actionable findings."}

_Generated for review generation ${publication.generation}._`,
    COMMENT_MAX_LENGTH,
  )
}

export function presentReviewCheck(
  publication: Publication,
  comment: string,
): ReviewCheckPresentation {
  const conclusion = publication.review.verdict === "pass" ? "success" : "action_required"
  return {
    conclusion,
    output: {
      title:
        conclusion === "success"
          ? "No changes requested"
          : `${publication.review.findings.length} finding(s) require attention`,
      summary: truncate(publication.review.summary, CHECK_OUTPUT_MAX_LENGTH),
      text: truncate(comment, CHECK_OUTPUT_MAX_LENGTH),
    },
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}
