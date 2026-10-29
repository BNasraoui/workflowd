import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"

const skillsDir = new URL("../skills/", import.meta.url)
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const skillText = (name: string) => readFileSync(new URL(`${name}/SKILL.md`, skillsDir), "utf8")

const commitRule =
  'A commit message has no `Co-Authored-By`, "Generated with", or other model or tool attribution line.'
const postRule = "A PR body or comment has none either."

// "commit" as an action, not a noun ("Record the commit with") or a refusal ("Do not commit").
const commitAction =
  /(?<!\b(?:not|never|n't|a|an|the|that|this|each|every|empty|full) )\bcommit (?:with|only|it|them|the|all|each|every|your|and)/i
const commitOrPush = [commitAction, /\bgit (?:commit|push)\b/]
const post = [
  /\bgh pr (?:create|edit|comment|review|merge)\b/,
  /\bgh issue comment\b/,
  /\bgh api\b[^`]*\/comments\b/,
]

const firstIndex = (text: string, patterns: RegExp[]) =>
  Math.min(...patterns.map((pattern) => text.search(pattern)).filter((index) => index >= 0))

const flatten = (text: string) => text.replace(/\s+/g, " ")

const commits = (text: string) =>
  Number.isFinite(firstIndex(flatten(text), [...commitOrPush, ...post]))

// The rule must come before the first commit, push, or post, so a worker reads it in time.
const refused = (text: string) => {
  const flat = flatten(text)
  const firstWrite = firstIndex(flat, [...commitOrPush, ...post])
  const firstPost = firstIndex(flat, post)
  const ruleBefore = (rule: string, limit: number) => {
    const index = flat.indexOf(rule)
    return index >= 0 && index < limit
  }
  return (
    (Number.isFinite(firstWrite) && !ruleBefore(commitRule, firstWrite)) ||
    (Number.isFinite(firstPost) && !ruleBefore(postRule, firstPost))
  )
}

test("a committing skill without the attribution rule is refused", () => {
  expect(refused("4. Commit with a message naming the phase, then push to `rpi/<id>`.")).toBe(true)
  expect(refused("Run `git push origin HEAD`.")).toBe(true)
  expect(refused("`gh pr comment <pr> --body-file review.md`")).toBe(true)
  expect(refused("`gh issue comment <n> --body done`")).toBe(true)
  expect(refused("`gh pr merge <pr> --squash`")).toBe(true)
  expect(refused("`gh api repos/o/r/issues/1/comments -f body=done`")).toBe(true)
  expect(refused("5. Do not commit anything.")).toBe(false)
  expect(refused("Read the code at the commit you read.")).toBe(false)
  expect(refused("Record the commit with `git rev-parse HEAD`.")).toBe(false)
  expect(refused("`gh api gists/<gist id> --jq '.history[0].version'`")).toBe(false)
})

test("the attribution rule placed after the first commit is refused", () => {
  const oldResearchPublish = `
2. Create branch \`rpi/<id>\` at the commit you read (\`git switch -c rpi/<id>\`) and push it. Open a draft PR for the
   ticket: \`gh pr create --draft --base <default branch> --head rpi/<id> --title "RPI <id>"\`
   with the gist URL in the body. If the branch has no changes yet, commit with
   \`--allow-empty\`.
3. If \`.provenance/\` exists, record the questions and research gists as Sources on
   \`rpi/<id>\`. Commit only the \`.provenance/\` changes and push.
   ${commitRule} ${postRule}
`
  expect(refused(oldResearchPublish)).toBe(true)
})

test("a skill that posts needs the PR body and comment half of the rule", () => {
  expect(refused(`${commitRule} Commit with a message, then \`gh pr create\`.`)).toBe(true)
  expect(refused(`${commitRule} Commit only the \`.provenance/\` changes and push.`)).toBe(false)
  expect(refused(`${commitRule} ${postRule} Commit with a message, then \`gh pr create\`.`)).toBe(
    false,
  )
})

test("the skills that commit, push, or post are found", () => {
  expect(skills.filter((name) => commits(skillText(name)))).toEqual([
    "qrspi-design-structure",
    "rpi-implement",
    "rpi-plan",
    "rpi-research",
    "rpi-review",
  ])
})

for (const name of skills) {
  test(`${name} forbids model and tool attribution before it commits, pushes, or posts`, () => {
    expect(refused(skillText(name))).toBe(false)
  })
}
