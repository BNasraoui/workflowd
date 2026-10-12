import { expect, test } from "bun:test"
import { join } from "node:path"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import { sandboxCompletionInstructions } from "../../src/sandbox/config"

test("OpenCode advertises host skills to ordinary sessions and only container skills to sandbox sessions", async () => {
  const fixture = await sharedOpenCodeFixture("skill-discovery")
  try {
    const control = await fixture.create(join(fixture.root, "control"), "build")
    fixture.script([])
    await fixture.prompt(control, "Describe the available skills.")
    expect(JSON.stringify(fixture.requests)).toContain("HOST_SKILL_MUST_NOT_BE_ADVERTISED")
    const before = fixture.requests.length
    const sandbox = await fixture.create(join(fixture.root, "sandbox"), "sandbox")
    fixture.script([])
    await fixture.prompt(sandbox, sandboxCompletionInstructions)
    const request = JSON.stringify(fixture.requests.slice(before))
    expect(request).not.toContain("HOST_SKILL_MUST_NOT_BE_ADVERTISED")
    expect(request).toContain("/opt/workflowd/skills/visual-pr/SKILL.md")
  } finally {
    await fixture.close()
  }
}, 120000)
