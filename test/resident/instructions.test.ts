import { expect, test } from "bun:test"
import { residentWorkerInstructions as instructions } from "../../src/resident/instructions"

test("incomplete CI observation preserves remaining work until final handoff", () => {
  expect(instructions).toContain("Missing or still-pending required checks")
  expect(instructions).toContain("watch timeout (exit 124)")
  expect(instructions).toContain("error connecting to api.github.com")
  expect(instructions).toContain("CI is still running")
  expect(instructions).toContain("Continue the remaining task")
  expect(instructions).toContain("At the final handoff")
  expect(instructions).toContain("CI is unverified")
  expect(instructions).toContain("three unsuccessful repair attempts")
  expect(instructions).not.toContain("then END YOUR TURN")
})

test("observation cycles retain stall, head verification and mailbox safeguards", () => {
  expect(instructions).toContain("timeout 12m gh pr checks")
  expect(instructions).toContain("each observation cycle to 15 minutes")
  expect(instructions).toContain("shorter budget if the configured stall window is lower")
  expect(instructions).toContain("Do not rely on shell output as a stall heartbeat")
  expect(instructions).toContain("Verify the PR still has the pushed head SHA")
  expect(instructions).toContain("do not call subscribe_to_event or subscribe.ts")
  expect(instructions).toContain("dispatch_agent/read_agent_mailbox")
  expect(instructions).toContain("receipt's mailbox_id")
  expect(instructions).toContain("end without watching CI")
})
