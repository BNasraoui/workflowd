import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { FixResult } from "../src/domain/fix-result"

const decode = (input: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(FixResult)(input))

describe("FixResult", () => {
  test("decodes a completed fixer result", async () => {
    const result = await decode({
        _tag: "CommitPrepared",
        summary: "Added an idempotency key and regression coverage.",
        commitSha: "a".repeat(40),
      })

    expect(result._tag).toBe("CommitPrepared")
  })

  test("decodes a no-change result without a commit SHA", async () => {
    const result = await decode({
      _tag: "NoChanges",
      summary: "The requested change is already present.",
    })

    expect(result).toEqual({
      _tag: "NoChanges",
      summary: "The requested change is already present.",
    })
  })

  test("rejects a prepared result without a commit SHA", async () => {
    await expect(
      decode({ _tag: "CommitPrepared", summary: "Prepared the fix." }),
    ).rejects.toBeDefined()
  })

  test("rejects a no-change result with a commit SHA", async () => {
    await expect(
      decode({
        _tag: "NoChanges",
        summary: "No fix was needed.",
        commitSha: "abc123",
      }),
    ).rejects.toBeDefined()
  })

  test.each([
    ["summary", { summary: "s".repeat(4_001) }],
    ["commit SHA", { commitSha: "a".repeat(65) }],
  ])("rejects an oversized %s", async (_description, overrides) => {
    await expect(
      decode({
        _tag: "CommitPrepared",
        summary: "Prepared the fix.",
        commitSha: "a".repeat(40),
        ...overrides,
      }),
    ).rejects.toBeDefined()
  })
})
