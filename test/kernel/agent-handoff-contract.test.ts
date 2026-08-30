import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  AgentSessionCompletedEventV1,
  WaitForAgentWorkflowV1,
  agentSessionCompletionCondition,
} from "../../src/kernel/agent-handoff-contract"

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }))

describe("provider-neutral agent handoff contracts", () => {
  test("decodes a versioned wait without provider-native identity", async () => {
    const wait = await decode(WaitForAgentWorkflowV1, {
      kind: "wait_for_agent",
      childSessionId: "child-stable",
      childSessionGeneration: 3,
      parentSessionId: "parent-stable",
      resumePrompt: { task: "Continue after the child result." },
      resumePromptText: '{"task":"Continue after the child result."}',
      outputContract: "workflow.parent-result",
      outputContractVersion: 2,
      retryPolicy: { maxAttempts: 4 },
    })

    expect(wait.childSessionId).toBe("child-stable")
    expect(JSON.stringify(wait)).not.toContain("nativeSession")
    expect(JSON.stringify(wait)).not.toContain("providerId")
    expect(agentSessionCompletionCondition(wait)).toEqual({
      type: "agent.session.completed",
      version: 1,
      key: "child-stable",
      correlation: "child-stable:3",
    })
  })

  test("decodes one provider-neutral completion fact", async () => {
    const completion = await decode(AgentSessionCompletedEventV1, {
      childSessionId: "child-stable",
      childSessionGeneration: 3,
      completionId: "answer-42",
      completedAt: "2026-08-14T09:00:00.000Z",
    })

    expect(completion.completionId).toBe("answer-42")
  })

  test("rejects provider-only fields and oversized exact prompts", async () => {
    await expect(
      decode(AgentSessionCompletedEventV1, {
        childSessionId: "child-stable",
        childSessionGeneration: 3,
        completionId: "answer-42",
        completedAt: "2026-08-14T09:00:00.000Z",
        nativeSessionId: "ses_private",
      }),
    ).rejects.toBeDefined()

    await expect(
      decode(WaitForAgentWorkflowV1, {
        kind: "wait_for_agent",
        childSessionId: "child-stable",
        childSessionGeneration: 3,
        parentSessionId: "parent-stable",
        resumePrompt: { task: "x" },
        resumePromptText: "x".repeat(65_537),
        outputContract: "workflow.parent-result",
        outputContractVersion: 2,
        retryPolicy: { maxAttempts: 4 },
      }),
    ).rejects.toBeDefined()
  })
})
