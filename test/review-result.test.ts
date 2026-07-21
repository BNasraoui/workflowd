import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ReviewResult } from "../src/domain/review-result"

const validFinding = {
  severity: "high" as const,
  title: "Retries duplicate the charge",
  body: "The retry path calls the provider without an idempotency key.",
  path: "src/payments.ts",
  line: 81,
}

const decode = (input: unknown) => Effect.runPromise(Schema.decodeUnknown(ReviewResult)(input))

describe("ReviewResult", () => {
  test("decodes a structured review result", async () => {
    const result = await decode({
      verdict: "changes_requested",
      summary: "One correctness issue needs attention.",
      findings: [validFinding],
    })

    expect(result.findings[0]?.severity).toBe("high")
    expect(result.verdict).toBe("changes_requested")
  })

  test.each([
    ["pass with findings", { verdict: "pass", findings: [validFinding] }],
    ["changes requested without findings", { verdict: "changes_requested", findings: [] }],
  ])("rejects the contradictory state: %s", async (_description, state) => {
    await expect(
      decode({
        summary: "Review complete.",
        ...state,
      }),
    ).rejects.toBeDefined()
  })

  test.each([
    ["summary", { summary: "s".repeat(4_001), findings: [validFinding] }],
    ["finding title", { findings: [{ ...validFinding, title: "t".repeat(201) }] }],
    ["finding body", { findings: [{ ...validFinding, body: "b".repeat(10_001) }] }],
    ["finding path", { findings: [{ ...validFinding, path: "p".repeat(1_025) }] }],
    ["finding count", { findings: Array(51).fill(validFinding) }],
  ])("rejects an oversized %s", async (_description, overrides) => {
    await expect(
      decode({
        verdict: "changes_requested",
        summary: "Review complete.",
        ...overrides,
      }),
    ).rejects.toBeDefined()
  })

  test.each([0, -1])("rejects the non-positive line number %i", async (line) => {
    await expect(
      decode({
        verdict: "changes_requested",
        summary: "Review complete.",
        findings: [{ ...validFinding, line }],
      }),
    ).rejects.toBeDefined()
  })
})
