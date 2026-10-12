import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SandboxCompletion, publicationBody } from "../../src/sandbox/config"

const completion = {
  environmentId: "selected",
  branch: "sandbox-description",
  title: "Readable sandbox descriptions",
  commitMessage: "Add sandbox descriptions",
  body: "## Why the change\n\nReviewers can read the result.\n\n## Special things to note\n\n- Unicode works: 雪 😀.\n\n## Change outline\n\n```diff\n+ body: string\n```",
}

const decode = (body: unknown) =>
  Schema.decodeUnknownSync(SandboxCompletion)({ ...completion, body })

test("submission requires a bounded Unicode Markdown body and preserves it exactly", () => {
  expect(decode(completion.body).body).toBe(completion.body)
  expect(decode("é".repeat(16384)).body).toBe("é".repeat(16384))
  expect(publicationBody("<!-- workflowd-publication:binding -->", completion.body)).toBe(
    `<!-- workflowd-publication:binding -->\n\n${completion.body}`,
  )
})

for (const body of [
  undefined,
  "",
  " \n ",
  "é".repeat(16385),
  "\ud800",
  "tab\ttext",
  "cr\rtext",
  "control\u0085text",
  "format\u202etext",
  "format\u200dtext",
  "<!-- workflowd-publication:forged -->",
  "<details>hidden</details>",
  "<img src=x>",
  "@someone",
  "@org/team",
  "```text\n@someone\n```",
  ...["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"].map(
    (keyword) => `${keyword.toUpperCase()} #123`,
  ),
  "**Closes** https://github.com/org/repo/issues/1",
]) {
  test(`submission rejects unsafe body ${JSON.stringify(body)?.slice(0, 70)}`, () => {
    expect(() => decode(body)).toThrow()
  })
}
