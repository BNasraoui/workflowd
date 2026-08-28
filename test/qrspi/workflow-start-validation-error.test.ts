import { describe, expect, test } from "bun:test"
import { WorkflowDefinitionValidationError } from "../../src/qrspi/domain"
import { QrspiStoreDataError } from "../../src/qrspi/store"
import { StageCatalogError } from "../../src/qrspi/stage-catalog"
import { toWorkflowStartValidationError } from "../../src/qrspi/workflow-start"

describe("toWorkflowStartValidationError", () => {
  test("carries workflow definition diagnostics without the source tag", () => {
    const diagnostic = toWorkflowStartValidationError(
      new WorkflowDefinitionValidationError({
        phase: "pure",
        reason: "duplicate_stage_key",
        workflowDefinitionSha256: "a".repeat(64),
        stageKey: "research",
        sequencePosition: 2,
      }),
    )

    expect(diagnostic._tag).toBe("WorkflowStartValidationError")
    expect(diagnostic.phase).toBe("pure")
    expect(diagnostic.reason).toBe("duplicate_stage_key")
    expect(diagnostic.workflowDefinitionSha256).toBe("a".repeat(64))
    expect(diagnostic.stageKey).toBe("research")
    expect(diagnostic.sequencePosition).toBe(2)
    expect(diagnostic.cause).toBeUndefined()
  })

  test("bounds a workflow definition cause to 1000 characters", () => {
    const diagnostic = toWorkflowStartValidationError(
      new WorkflowDefinitionValidationError({
        phase: "harness",
        reason: "unknown_harness_reference",
        harnessRef: { name: "opencode", version: 1 },
        cause: "x".repeat(2_000),
      }),
    )

    expect(diagnostic.phase).toBe("harness")
    expect(diagnostic.reason).toBe("unknown_harness_reference")
    expect(diagnostic.harnessRef).toEqual({ name: "opencode", version: 1 })
    expect(diagnostic.cause).toBe("x".repeat(1_000))
  })

  test("reports a stage catalog failure as a contract phase with the reference as cause", () => {
    const diagnostic = toWorkflowStartValidationError(
      new StageCatalogError({ reason: "unknown_reference", reference: "research@1" }),
    )

    expect(diagnostic.phase).toBe("contract")
    expect(diagnostic.reason).toBe("unknown_reference")
    expect(diagnostic.cause).toBe("research@1")
  })

  test("joins the stage catalog reference and cause when both are present", () => {
    const diagnostic = toWorkflowStartValidationError(
      new StageCatalogError({
        reason: "identity_mismatch",
        reference: "plan@2",
        cause: "y".repeat(2_000),
      }),
    )

    expect(diagnostic.phase).toBe("contract")
    expect(diagnostic.reason).toBe("identity_mismatch")
    expect(diagnostic.cause).toBe(`plan@2: ${"y".repeat(1_000 - "plan@2: ".length)}`)
  })

  test("defaults a store data error without a reason to malformed", () => {
    const diagnostic = toWorkflowStartValidationError(
      new QrspiStoreDataError({
        record: "workflow_operation",
        recordId: "operation-1",
        message: "row is not decodable",
      }),
    )

    expect(diagnostic.phase).toBe("persisted")
    expect(diagnostic.reason).toBe("malformed")
    expect(diagnostic.record).toBe("workflow_operation")
    expect(diagnostic.recordId).toBe("operation-1")
    expect(diagnostic.cause).toBe("row is not decodable")
    expect(diagnostic.workflowId).toBeUndefined()
    expect(diagnostic.generation).toBeUndefined()
    expect(diagnostic.sequencePosition).toBeUndefined()
    expect(diagnostic.expectedSha256).toBeUndefined()
    expect(diagnostic.actualSha256).toBeUndefined()
  })

  test("forwards every optional persisted identity field when present", () => {
    const diagnostic = toWorkflowStartValidationError(
      new QrspiStoreDataError({
        record: "stage_definition",
        recordId: "snapshot-9",
        message: "hash mismatch",
        reason: "hash_mismatch",
        workflowId: "workflow-7",
        generation: 3,
        sequencePosition: 4,
        expectedSha256: "b".repeat(64),
        actualSha256: "c".repeat(64),
      }),
    )

    expect(diagnostic.phase).toBe("persisted")
    expect(diagnostic.reason).toBe("hash_mismatch")
    expect(diagnostic.record).toBe("stage_definition")
    expect(diagnostic.recordId).toBe("snapshot-9")
    expect(diagnostic.workflowId).toBe("workflow-7")
    expect(diagnostic.generation).toBe(3)
    expect(diagnostic.sequencePosition).toBe(4)
    expect(diagnostic.expectedSha256).toBe("b".repeat(64))
    expect(diagnostic.actualSha256).toBe("c".repeat(64))
    expect(diagnostic.cause).toBe("hash mismatch")
  })
})
