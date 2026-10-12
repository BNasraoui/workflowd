import { expect, test } from "bun:test"
import catalog from "../../deploy/sandbox/skills/catalog.json"
import { sandboxCompletionInstructions } from "../../src/sandbox/config"
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
