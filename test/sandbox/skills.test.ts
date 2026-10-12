import { expect, test } from "bun:test"
import { Schema } from "effect"
import catalog from "../../deploy/sandbox/skills/catalog.json"
import { PublicationBody, sandboxCompletionInstructions } from "../../src/sandbox/config"
import { sandboxRules } from "../../src/sandbox/binding"

test("every pinned image skill is advertised once at its container path", () => {
  expect(catalog.skills).toHaveLength(10)
  for (const skill of catalog.skills) {
    const path = `${catalog.root}/${skill.name}/SKILL.md`
    expect(sandboxCompletionInstructions.split(path)).toHaveLength(2)
    expect(sandboxCompletionInstructions).toContain(skill.description)
  }
  expect(sandboxCompletionInstructions).not.toContain("/home/ben")
  expect(sandboxCompletionInstructions).toContain("visual-pr")
  expect(sandboxCompletionInstructions).toContain("body")
})

test("OpenCode sandbox denies native skill discovery", () => {
  const matches = sandboxRules.filter((rule) => rule.action === "*" || rule.action === "skill")
  expect(matches.at(-1)?.effect).toBe("deny")
})

test("repository skills and trimmed descriptions are advertised", () => {
  expect(sandboxCompletionInstructions).toContain("/workdir/.agents/skills")
  expect(sandboxCompletionInstructions).toContain("/workdir/.claude/skills")
  for (const skill of catalog.skills) expect(skill.description).toBe(skill.description.trim())
})

test("vendored visual-pr reference examples satisfy publication rules", async () => {
  for (const file of ["show-me.md", "pr_description_template.md"]) {
    const body = await Bun.file(`deploy/sandbox/skills/visual-pr/references/${file}`).text()
    expect(Schema.is(PublicationBody)(body)).toBe(true)
  }
})
