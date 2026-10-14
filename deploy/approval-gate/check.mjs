import { pathToFileURL } from "node:url"

const repository = "BNasraoui/workflowd"
const root = `/repos/${repository}`

function requireEligiblePr(pr, sha) {
  if (
    pr.state !== "open" ||
    pr.merged !== false ||
    pr.draft !== false ||
    pr.base?.ref !== "main" ||
    pr.base?.repo?.full_name !== repository ||
    pr.head?.sha !== sha ||
    pr.requested_reviewers?.length !== 0 ||
    pr.requested_teams?.length !== 0
  )
    throw new Error(
      "PR must be open, ready, target main, match the supplied SHA, and have no outstanding review requests",
    )
}

// API errors, unexpected responses and incomplete pagination fail closed.
async function list(request, path, key) {
  const items = []
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    )
    const batch = key ? response[key] : response
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub list response")
    items.push(...batch)
    if (batch.length < 100) return items
  }
  throw new Error("GitHub pagination limit reached; approval refused")
}

export async function runGate(mode, env, request) {
  const sha = env.HEAD_SHA
  if (
    !["validate", "publish"].includes(mode) ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    !/^[1-9][0-9]*$/.test(env.PR_NUMBER ?? "") ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[a-f0-9]{40}$/.test(sha ?? "")
  )
    throw new Error(
      "Use a fresh workflow_dispatch from main with a PR number and full lowercase head SHA",
    )
  const prPath = `${root}/pulls/${env.PR_NUMBER}`
  requireEligiblePr(await request(prPath), sha)
  const approvals = await request(`${root}/actions/runs/${env.GITHUB_RUN_ID}/approvals`)
  const reviewsOfEnvironment = approvals.filter((approval) =>
    approval.environments.some((environment) => environment.name === "ben-merge-approval"),
  )
  if (
    !reviewsOfEnvironment.some(
      (approval) => approval.state === "approved" && approval.user.id === 81005232,
    ) ||
    reviewsOfEnvironment.some((approval) => approval.state !== "approved")
  )
    throw new Error("This run requires Ben's recorded environment approval")

  const reviews = await list(request, `${prPath}/reviews`)
  const latest = new Map()
  for (const review of reviews.sort((a, b) => a.id - b.id)) {
    if (review.state === "PENDING") throw new Error("An independent review is still pending")
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latest.set(review.user.id, review.state)
    else if (review.state !== "COMMENTED") throw new Error("Unrecognized review state")
  }
  if ([...latest.values()].includes("CHANGES_REQUESTED"))
    throw new Error("An independent review still requests changes")
  const checks = await list(
    request,
    `${root}/commits/${sha}/check-runs?filter=latest`,
    "check_runs",
  )
  if (
    !checks.some(
      (check) =>
        check.name === "Required checks" &&
        check.app?.id === 15368 &&
        check.conclusion === "success",
    )
  )
    throw new Error("Required checks from GitHub Actions must pass first")
  if (
    checks.some(
      (check) =>
        check.status !== "completed" ||
        !["success", "neutral", "skipped"].includes(check.conclusion),
    )
  )
    throw new Error("A check (including any independent review) is pending or unsuccessful")
  const statuses = await list(request, `${root}/commits/${sha}/status`, "statuses")
  if (statuses.some((status) => status.state !== "success"))
    throw new Error("A commit status is pending or unsuccessful")
  // Narrow the read/write race. A subsequent push cannot reuse this SHA-bound check.
  requireEligiblePr(await request(prPath), sha)
  if (mode === "publish")
    await request(`${root}/check-runs`, {
      name: "Ben approval",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      details_url: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      output: {
        title: "Ben approved this PR head",
        summary: `PR #${env.PR_NUMBER}, head ${sha}. Protected environment approval and visible review/check state verified.`,
      },
    })
}

export async function githubRequest(path, body) {
  const token = body ? process.env.APP_TOKEN : process.env.GITHUB_TOKEN
  if (!token) throw new Error("Missing scoped GitHub token")
  const response = await fetch(`https://api.github.com${path}`, {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  })
  // Never log response bodies or credentials.
  if (!response.ok)
    throw new Error(`GitHub ${body ? "POST" : "GET"} failed: HTTP ${response.status}`)
  return response.json()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runGate(process.argv[2], process.env, githubRequest)
    console.log("Approval gate validation completed")
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
