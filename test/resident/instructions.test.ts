import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { residentWorkerInstructions as instructions } from "../../src/resident/instructions"

test("incomplete CI observation preserves remaining work until final handoff", () => {
  expect(instructions).toContain("Missing or still-pending required checks")
  expect(instructions).toContain("observation timeout")
  expect(instructions).toContain("error connecting to api.github.com")
  expect(instructions).toContain("CI is still running")
  expect(instructions).toContain("Continue the remaining task")
  expect(instructions).toContain("At the final handoff")
  expect(instructions).toContain("CI is unverified")
  expect(instructions).toContain("three unsuccessful repair attempts")
  expect(instructions).not.toContain("then END YOUR TURN")
  expect(instructions).not.toContain("Retry only")
})

test("observation cycles retain stall, head verification and mailbox safeguards", () => {
  expect(instructions).toContain("each observation cycle to 15 minutes")
  expect(instructions).toContain("shorter budget if the configured stall window is lower")
  expect(instructions).toContain("Do not rely on shell output as a stall heartbeat")
  expect(instructions).toContain("Verify the PR still has the pushed head SHA")
  expect(instructions).toContain("do not call subscribe_to_event or subscribe.ts")
  expect(instructions).toContain("dispatch_agent/read_agent_mailbox")
  expect(instructions).toContain("receipt's mailbox_id")
  expect(instructions).toContain("end without watching CI")
})

test("skill handoff follows every phase and precedes polling defaults", () => {
  expect(instructions).toStartWith(
    "You are a resident workflowd worker. Follow an active skill's end-turn/handoff instructions first:",
  )
  expect(instructions).toContain(
    "ending at its handoff step (such as rpi-implement's Finish), finish all earlier phases first",
  )
})

test("handoff verifies the last pushed head and reports early stops and observation errors", () => {
  expect(instructions).toContain(
    "the verified result must be for the last pushed head SHA; results for earlier SHAs do not verify it",
  )
  expect(instructions).toContain(
    "Any other observation error: treat CI as unverified, continue, and report it at handoff",
  )
  expect(instructions).toContain(
    "At an early stop, provide the same report plus the failing check's link",
  )
  expect(instructions).toContain(
    "never run back-to-back blocking waits without returning to task work in between; no single cycle may exceed the budget",
  )
})

for (const { source, content } of [
  { source: "resident prompt", content: instructions },
  ...["skills/rpi-implement/SKILL.md", "docs/agent-inboxes-ci.md", "docs/mcp-server.md"].map(
    (path) => ({
      source: path,
      content: readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
    }),
  ),
]) {
  test(`${source} confirms the aggregate on drafts and tolerates check creation`, () => {
    const text = content.replace(/\s+/g, " ")
    expect(text).toMatch(/gh pr checks (PR_NUMBER|<pr>) --repo (OWNER\/NAME|<owner\/repo>)/)
    expect(text).not.toMatch(/gh pr checks[^.\n`]*--(?:required|watch)/)
    expect(text).toContain("every 60 seconds")
    expect(text).toContain("draft and ready PRs")
    expect(text).toContain("Required checks")
    expect(text).toContain("missing aggregate is pending, never success")
    expect(text).toContain("Only an explicit pass/success of the aggregate verifies CI")
    expect(text).toContain("fail/failure is a confirmed CI failure")
    expect(text).toContain("skipped or cancelled aggregate is unverified")
    expect(text).toContain("OpenCode Review")
    expect(text).toContain("exit code alone")
    expect(text).toContain("15 minutes")
    expect(text).toContain("CI is unverified")
  })
}
