import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"

const skillsDir = new URL("../skills/", import.meta.url)
const rpiStages = readdirSync(skillsDir).filter(
  (name) => name.startsWith("rpi-") && name !== "rpi-coordinate",
)

const commits = (text: string) =>
  /`rpi\/<id>`|\bgit (commit|push)\b|gh pr (create|ready|edit|comment)|\bCommit (with|only|the)\b/.test(
    text,
  )

const forbidsAttribution = (text: string) => {
  const flat = text.replace(/\s+/g, " ")
  return (
    flat.includes(
      'A commit message has no `Co-Authored-By`, "Generated with", or other model or tool attribution line.',
    ) && flat.includes("A PR body or comment has none either.")
  )
}

const refused = (text: string) => commits(text) && !forbidsAttribution(text)

test("a committing RPI stage without the attribution rule is refused", () => {
  expect(refused("4. Commit with a message naming the phase, then push to `rpi/<id>`.")).toBe(true)
  expect(refused("5. Do not commit anything.")).toBe(false)
})

test("the RPI stages that commit are found", () => {
  expect(
    rpiStages
      .filter((name) => commits(readFileSync(new URL(`${name}/SKILL.md`, skillsDir), "utf8")))
      .sort(),
  ).toEqual(["rpi-implement", "rpi-plan", "rpi-research", "rpi-review"])
})

for (const name of rpiStages) {
  test(`${name} forbids model and tool attribution when it commits`, () => {
    expect(refused(readFileSync(new URL(`${name}/SKILL.md`, skillsDir), "utf8"))).toBe(false)
  })
}
