import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { MAX_STAGE_REQUEST_BYTES } from "../../src/agent-harness"
import { TicketRevision, canonicalSha256, ticketRevisionSha256For } from "../../src/qrspi/domain"
import {
  ExactStageSources,
  ImplementationRequest,
  ImplementationResult,
  DesignRequest,
  DesignResult,
  PreparedStageOutput,
  StageExecutionContext,
  StageProduceInput,
  StageTaskAuthority,
  MAX_DOCUMENT_RESULT_BYTES,
  MAX_EXACT_STAGE_SOURCES_BYTES,
  PlanRequest,
  PlanResult,
  QuestionsRequest,
  QuestionsResult,
  ResearchRequest,
  ResearchResult,
  StructureAuthority,
  StructureRequest,
  StructureResult,
  designStageContract,
  encodeStageProduceInput,
  questionsStageContract,
  implementationStageContract,
  planStageContract,
  researchStageContract,
  structureStageContract,
} from "../../src/qrspi/contracts"
import { TrustedStageCatalog } from "../../src/qrspi/stage-catalog"

const sha = (character: string) => character.repeat(64)
const scope = {
  workflowId: `wf_${sha("a")}`,
  generation: 1,
  stageKey: "questions",
  runOrdinal: 1,
  stageRevision: 1,
  workflowDefinitionSha256: sha("b"),
  stageDefinitionSha256: sha("c"),
}
const verifiedTicket = verifiedTicketRevision()
const ticketRevision = {
  workflowId: scope.workflowId,
  ticketRevisionSha256: verifiedTicket.ticketRevisionSha256,
}
const target = {
  repository: {
    providerInstanceId: "github-app-1",
    repositoryId: "repository-1",
    repositoryFullName: "owner/repository",
  },
  headRef: "refs/heads/workflow",
  expectedParentSha: "e".repeat(40),
}
const sources = {
  ...scope,
  ticketRevision,
  sources: [] as const,
  sourceSetSha256: canonicalSha256([]),
  target,
}
const researchScope = { ...scope, stageKey: "research", stageDefinitionSha256: sha("d") }
const researchArtifact = {
  repository: target.repository,
  workflowId: scope.workflowId,
  generation: scope.generation,
  stageKey: "questions",
  stageRevision: 1,
  commitSha: "1".repeat(40),
  path: "artifacts/questions.md",
  blobSha: "2".repeat(40),
  contentSha256: sha("3"),
  mediaType: "text/markdown",
}
function acceptedPointerFor(
  role: "Questions" | "Research" | "Design" | "Structure" | "Plan",
  artifact: typeof researchArtifact,
  marker: string,
) {
  const identity = {
    role,
    snapshotSha256: sha(marker),
    runOrdinal: 1,
    acceptedStageRevision: artifact.stageRevision,
    targetParentSha: target.expectedParentSha,
    contract: { name: `qrspi.${role.toLowerCase()}`, contractVersion: 1 },
    contractRegistrationSha256: sha(marker),
    artifact,
  }
  return { ...identity, pointerSha256: canonicalSha256(identity) }
}
const researchSource = {
  role: "Questions" as const,
  artifact: researchArtifact,
  acceptedPointer: acceptedPointerFor("Questions", researchArtifact, "1"),
  content: "# Persisted Questions",
}
const researchSources = {
  ...researchScope,
  ticketRevision,
  sources: [researchSource],
  sourceSetSha256: canonicalSha256([{ role: "Questions", artifact: researchArtifact }]),
  target,
}
const designScope = { ...scope, stageKey: "design", stageDefinitionSha256: sha("4") }
const designResearchArtifact = {
  ...researchArtifact,
  stageKey: "research",
  path: "artifacts/research.md",
  commitSha: "4".repeat(40),
  blobSha: "5".repeat(40),
  contentSha256: sha("6"),
}
const designResearchSource = {
  role: "Research" as const,
  artifact: designResearchArtifact,
  acceptedPointer: acceptedPointerFor("Research", designResearchArtifact, "4"),
  content: "# Persisted Research",
}
const designSources = {
  ...designScope,
  ticketRevision,
  sources: [designResearchSource, researchSource],
  sourceSetSha256: canonicalSha256([
    { role: "Research", artifact: designResearchArtifact },
    { role: "Questions", artifact: researchArtifact },
  ]),
  target,
}
const structureScope = { ...scope, stageKey: "structure", stageDefinitionSha256: sha("7") }
const structureDesignArtifact = {
  ...researchArtifact,
  stageKey: "design",
  path: "artifacts/design.md",
  commitSha: "7".repeat(40),
  blobSha: "8".repeat(40),
  contentSha256: sha("9"),
}
const structureDesignSource = {
  role: "Design" as const,
  artifact: structureDesignArtifact,
  acceptedPointer: acceptedPointerFor("Design", structureDesignArtifact, "7"),
  content: "# Persisted Design",
}
const structureSources = {
  ...structureScope,
  ticketRevision,
  sources: [structureDesignSource, designResearchSource, researchSource],
  sourceSetSha256: canonicalSha256([
    { role: "Design", artifact: structureDesignArtifact },
    { role: "Research", artifact: designResearchArtifact },
    { role: "Questions", artifact: researchArtifact },
  ]),
  target,
}
const structureAuthority = {
  acceptancePackage: {
    workflowId: scope.workflowId,
    generation: scope.generation,
    designStageRevision: 1,
    packageSha256: sha("1"),
  },
  gateResponse: {
    workflowId: scope.workflowId,
    generation: scope.generation,
    designStageRevision: 1,
    packageSha256: sha("1"),
    responseSha256: sha("2"),
  },
  promotionResult: {
    workflowId: scope.workflowId,
    generation: scope.generation,
    designStageRevision: 1,
    packageSha256: sha("1"),
    gateResponseSha256: sha("2"),
    resultSha256: sha("3"),
  },
  graph: {
    repository: target.repository,
    workflowId: scope.workflowId,
    generation: scope.generation,
    commitSha: "a".repeat(40),
    scope: "workflowd-vs3-4-2",
    graphSha256: sha("4"),
  },
}
const planScope = { ...scope, stageKey: "plan", stageDefinitionSha256: sha("8") }
const planStructureArtifact = {
  ...researchArtifact,
  stageKey: "structure",
  path: "artifacts/structure.md",
  commitSha: "b".repeat(40),
  blobSha: "c".repeat(40),
  contentSha256: sha("d"),
}
const planStructureSource = {
  role: "Structure" as const,
  artifact: planStructureArtifact,
  acceptedPointer: acceptedPointerFor("Structure", planStructureArtifact, "b"),
  content: "# Persisted Structure",
}
const planSources = {
  ...planScope,
  ticketRevision,
  sources: [planStructureSource, structureDesignSource, designResearchSource, researchSource],
  sourceSetSha256: canonicalSha256([
    { role: "Structure", artifact: planStructureArtifact },
    { role: "Design", artifact: structureDesignArtifact },
    { role: "Research", artifact: designResearchArtifact },
    { role: "Questions", artifact: researchArtifact },
  ]),
  target,
}
const implementationScope = {
  ...scope,
  stageKey: "implementation",
  stageDefinitionSha256: sha("9"),
}
const implementationPlanArtifact = {
  ...researchArtifact,
  stageKey: "plan",
  path: "artifacts/plan.md",
  commitSha: "d".repeat(40),
  blobSha: "e".repeat(40),
  contentSha256: sha("f"),
}
const implementationPlanSource = {
  role: "Plan" as const,
  artifact: implementationPlanArtifact,
  acceptedPointer: acceptedPointerFor("Plan", implementationPlanArtifact, "d"),
  content: "# Persisted Plan",
}
const implementationSources = {
  ...implementationScope,
  ticketRevision,
  sources: [
    implementationPlanSource,
    planStructureSource,
    structureDesignSource,
    designResearchSource,
    researchSource,
  ],
  sourceSetSha256: canonicalSha256([
    { role: "Plan", artifact: implementationPlanArtifact },
    { role: "Structure", artifact: planStructureArtifact },
    { role: "Design", artifact: structureDesignArtifact },
    { role: "Research", artifact: designResearchArtifact },
    { role: "Questions", artifact: researchArtifact },
  ]),
  target,
}

function verifiedTicketRevision() {
  const readyTicket = {
    reference: {
      tracker: "beads" as const,
      trackerInstanceId: "workspace-42",
      nativeTicketId: "workflowd-vs3.4.2",
    },
    issueType: "feature" as const,
    title: "Build exact Questions replay",
    description: "Persist and replay one exact typed Questions request.",
    sources: ["https://example.test/contract"],
    acceptanceCriteria: ["The exact request replays."],
    scenarios: [
      {
        name: "Replay",
        given: "an exact persisted request",
        when: "the task is rebuilt",
        then: "the same authority is selected",
      },
    ],
  }
  const scenarioCoverage = [[0]]
  return Schema.decodeUnknownSync(TicketRevision)({
    readyTicket,
    scenarioCoverage,
    checkedAt: new Date("2026-07-24T00:00:00.000Z"),
    ticketRevisionSha256: ticketRevisionSha256For(readyTicket, scenarioCoverage),
  })
}

describe("shared exact stage contracts", () => {
  test("decodes finite scope, empty ordered sources, authority, context, and prepared output", () => {
    expect(Schema.decodeUnknownSync(ExactStageSources)(sources)).toEqual(sources)
    expect(Schema.decodeUnknownSync(StageTaskAuthority)({ ticketRevision, sources: [] })).toEqual({
      ticketRevision,
      sources: [],
    })
    expect(Schema.decodeUnknownSync(StageExecutionContext)({ scope, target })).toEqual({
      scope,
      target,
    })
    expect(
      Schema.decodeUnknownSync(PreparedStageOutput)({ _tag: "Document", text: "Questions" }),
    ).toEqual({ _tag: "Document", text: "Questions" })
  })

  test("round trips a new-format StageProduceInput and verifies request identity", () => {
    const request = { _tag: "QuestionsRequest", sources }
    const encoded = encodeStageProduceInput(
      scope,
      { name: "qrspi.questions", contractVersion: 1 },
      request,
    )

    expect(Schema.decodeUnknownSync(StageProduceInput)(encoded)).toEqual(encoded)
    expect(encoded.requestSha256).toBe(canonicalSha256(request))

    const mutated = { ...structuredClone(encoded), request: { ...request, _tag: "OtherRequest" } }
    expect(() => Schema.decodeUnknownSync(StageProduceInput)(mutated)).toThrow("requestSha256")
  })

  test("independently verifies the ordered source-set hash", () => {
    const request = {
      _tag: "QuestionsRequest",
      sources: { ...sources, sourceSetSha256: sha("f") },
    }
    const encoded = encodeStageProduceInput(
      scope,
      { name: "qrspi.questions", contractVersion: 1 },
      request,
    )

    expect(() => Schema.decodeUnknownSync(StageProduceInput)(encoded)).toThrow("sourceSetSha256")
  })

  test("bounds a maximum-cardinality source envelope at the exact encoded boundary", () => {
    const baseBytes = Buffer.byteLength(JSON.stringify(implementationSources), "utf8")
    const originalBytes = Buffer.byteLength(implementationPlanSource.content, "utf8")
    const exactContent = "x".repeat(MAX_EXACT_STAGE_SOURCES_BYTES - baseBytes + originalBytes)
    const exactSources = {
      ...implementationSources,
      sources: [
        { ...implementationPlanSource, content: exactContent },
        ...implementationSources.sources.slice(1),
      ],
    }

    expect(Buffer.byteLength(JSON.stringify(exactSources), "utf8")).toBe(
      MAX_EXACT_STAGE_SOURCES_BYTES,
    )
    expect(Schema.decodeUnknownSync(ExactStageSources)(exactSources)).toEqual(exactSources)
    const request = {
      _tag: "ImplementationRequest" as const,
      sources: exactSources,
      checkpointPosition: 1,
      expectedParentSha: target.expectedParentSha,
    }
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(
      MAX_STAGE_REQUEST_BYTES,
    )
    expect(Schema.decodeUnknownSync(ImplementationRequest)(request)).toEqual(request)
    expect(() =>
      Schema.decodeUnknownSync(ExactStageSources)({
        ...exactSources,
        sources: [
          { ...exactSources.sources[0], content: `${exactContent}x` },
          ...exactSources.sources.slice(1),
        ],
      }),
    ).toThrow("encoded bytes")
  })

  test("rejects the historical placeholder child input", () => {
    expect(() =>
      Schema.decodeUnknownSync(StageProduceInput)({
        stageKey: "questions",
        stageKind: "document",
        stageRevision: 1,
        workflowDefinitionSha256: sha("a"),
      }),
    ).toThrow()
  })
})

describe("exact Questions contract through erased catalog execution", () => {
  test("assembles, rebuilds Ticket-first authority, and prepares a document", async () => {
    const catalog = new TrustedStageCatalog([questionsStageContract]).port()
    const request = await Effect.runPromise(
      catalog.assembleRequest({
        contract: questionsStageContract.ref,
        sources,
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )
    expect(Schema.decodeUnknownSync(QuestionsRequest)(request)).toEqual({
      _tag: "QuestionsRequest",
      sources,
    })
    const durableInput = encodeStageProduceInput(scope, questionsStageContract.ref, request)
    expect(Schema.decodeUnknownSync(StageProduceInput)(durableInput)).toEqual(durableInput)

    const task = await Effect.runPromise(
      catalog.buildTask({ input: durableInput, ticketRevision: verifiedTicket }),
    )
    expect(task).toMatchObject({
      title: "Answer workflow questions",
      authority: { ticketRevision, sources: [] },
    })
    expect(task.prompt).not.toContain("Build exact Questions replay")

    expect(
      await Effect.runPromise(
        catalog.prepareOutput({
          contract: questionsStageContract.ref,
          result: { _tag: "Questions", document: "# Questions" },
          context: { scope, target },
        }),
      ),
    ).toEqual({ _tag: "Document", text: "# Questions" })
  })

  test("rejects wrong request/result tags and mismatched ticket authority", async () => {
    const catalog = new TrustedStageCatalog([questionsStageContract]).port()
    const badRequest = encodeStageProduceInput(scope, questionsStageContract.ref, {
      _tag: "ResearchRequest",
      sources,
    })
    const wrongTicket = {
      ...verifiedTicketRevision(),
      ticketRevisionSha256: "f".repeat(64),
    }

    expect(
      await Effect.runPromise(
        catalog
          .buildTask({ input: badRequest, ticketRevision: verifiedTicket })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
    const validRequest = encodeStageProduceInput(scope, questionsStageContract.ref, {
      _tag: "QuestionsRequest",
      sources,
    })
    expect(
      await Effect.runPromise(
        catalog.buildTask({ input: validRequest, ticketRevision: wrongTicket }).pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })
    expect(
      await Effect.runPromise(
        catalog
          .prepareOutput({
            contract: questionsStageContract.ref,
            result: { _tag: "Research", document: "wrong" },
            context: { scope, target },
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_result" } })
  })

  test("rejects predecessor authority for Questions during assembly and replay", async () => {
    const catalog = new TrustedStageCatalog([questionsStageContract]).port()
    const invalidSources = {
      ...sources,
      sources: [researchSource],
      sourceSetSha256: canonicalSha256([{ role: "Questions", artifact: researchArtifact }]),
    }

    expect(
      await Effect.runPromise(
        catalog
          .assembleRequest({
            contract: questionsStageContract.ref,
            sources: invalidSources,
            maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })

    const request = { _tag: "QuestionsRequest" as const, sources: invalidSources }
    expect(
      await Effect.runPromise(
        catalog
          .buildTask({
            input: encodeStageProduceInput(scope, questionsStageContract.ref, request),
            ticketRevision: verifiedTicket,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
  })

  test("enforces exact UTF-8 document and configured complete-request byte boundaries", async () => {
    const exactDocument = "é".repeat(MAX_DOCUMENT_RESULT_BYTES / 2)
    expect(
      Schema.decodeUnknownSync(QuestionsResult)({
        _tag: "Questions",
        document: exactDocument,
      }),
    ).toEqual({ _tag: "Questions", document: exactDocument })
    expect(() =>
      Schema.decodeUnknownSync(QuestionsResult)({
        _tag: "Questions",
        document: `${exactDocument}a`,
      }),
    ).toThrow()

    const catalog = new TrustedStageCatalog([questionsStageContract]).port()
    const expected = { _tag: "QuestionsRequest", sources }
    const exactBytes = Buffer.byteLength(JSON.stringify(expected), "utf8")
    expect(
      await Effect.runPromise(
        catalog.assembleRequest({
          contract: questionsStageContract.ref,
          sources,
          maxEncodedInputBytes: exactBytes,
        }),
      ),
    ).toEqual(expected)
    expect(
      await Effect.runPromise(
        catalog
          .assembleRequest({
            contract: questionsStageContract.ref,
            sources,
            maxEncodedInputBytes: exactBytes - 1,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "request_too_large" } })

    const exactResult = { _tag: "Questions" as const, document: "é" }
    const exactResultBytes = Buffer.byteLength(JSON.stringify(exactResult), "utf8")
    const boundedResultContract = {
      ...questionsStageContract,
      implementationRevision: "qrspi.questions.result-boundary.v1",
      maxResultBytes: exactResultBytes,
    }
    const boundedCatalog = new TrustedStageCatalog([boundedResultContract]).port()
    expect(
      await Effect.runPromise(
        boundedCatalog.prepareOutput({
          contract: boundedResultContract.ref,
          result: exactResult,
          context: { scope, target },
        }),
      ),
    ).toEqual({ _tag: "Document", text: "é" })
    expect(
      await Effect.runPromise(
        boundedCatalog
          .prepareOutput({
            contract: boundedResultContract.ref,
            result: { ...exactResult, document: "éa" },
            context: { scope, target },
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "result_too_large" } })
  })
})

describe("exact Research contract through erased catalog execution", () => {
  test("assembles persisted Questions content and rebuilds Ticket-first authority", async () => {
    const catalog = new TrustedStageCatalog([questionsStageContract, researchStageContract]).port()

    const request = await Effect.runPromise(
      catalog.assembleRequest({
        contract: researchStageContract.ref,
        sources: researchSources,
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )
    expect(Schema.decodeUnknownSync(ResearchRequest)(request)).toEqual({
      _tag: "ResearchRequest",
      sources: researchSources,
    })

    const task = await Effect.runPromise(
      catalog.buildTask({
        input: encodeStageProduceInput(researchScope, researchStageContract.ref, request),
        ticketRevision: verifiedTicket,
      }),
    )
    expect(task).toMatchObject({
      title: "Research workflow solution",
      authority: { ticketRevision, sources: [researchSource] },
    })
    expect(task.prompt).not.toContain("# Persisted Questions")
  })

  test("rejects wrong source and request tags through the selected Research registration", async () => {
    const catalog = new TrustedStageCatalog([researchStageContract]).port()
    const wrongRole = {
      ...researchSources,
      sources: [{ ...researchSource, role: "Research" as const }],
      sourceSetSha256: canonicalSha256([{ role: "Research", artifact: researchSource.artifact }]),
    }

    expect(
      await Effect.runPromise(
        catalog
          .assembleRequest({
            contract: researchStageContract.ref,
            sources: wrongRole,
            maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
    expect(
      await Effect.runPromise(
        catalog
          .buildTask({
            input: encodeStageProduceInput(researchScope, researchStageContract.ref, {
              _tag: "QuestionsRequest",
              sources: researchSources,
            }),
            ticketRevision: verifiedTicket,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
  })

  test("rejects rehashed cross-scope artifact authority during durable replay", async () => {
    const catalog = new TrustedStageCatalog([researchStageContract]).port()
    const artifact = { ...researchArtifact, workflowId: `wf_${sha("f")}` }
    const source = { ...researchSource, artifact }
    const changedSources = {
      ...researchSources,
      sources: [source],
      sourceSetSha256: canonicalSha256([{ role: "Questions", artifact }]),
    }
    const request = { _tag: "ResearchRequest" as const, sources: changedSources }
    const input = encodeStageProduceInput(researchScope, researchStageContract.ref, request)

    expect(
      await Effect.runPromise(
        catalog.buildTask({ input, ticketRevision: verifiedTicket }).pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
  })

  test("rechecks the complete encoded request bound during durable replay", async () => {
    const catalog = new TrustedStageCatalog([researchStageContract]).port()
    const oversizedSource = { ...researchSource, content: "x".repeat(MAX_STAGE_REQUEST_BYTES) }
    const oversizedSources = { ...researchSources, sources: [oversizedSource] }
    const request = { _tag: "ResearchRequest" as const, sources: oversizedSources }

    expect(
      await Effect.runPromise(
        catalog
          .buildTask({
            input: encodeStageProduceInput(researchScope, researchStageContract.ref, request),
            ticketRevision: verifiedTicket,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "request_too_large" } })
  })

  test("projects only bounded Research results", async () => {
    const catalog = new TrustedStageCatalog([researchStageContract]).port()
    const exactDocument = "é".repeat(MAX_DOCUMENT_RESULT_BYTES / 2)
    expect(
      Schema.decodeUnknownSync(ResearchResult)({ _tag: "Research", document: exactDocument }),
    ).toEqual({ _tag: "Research", document: exactDocument })
    expect(() =>
      Schema.decodeUnknownSync(ResearchResult)({
        _tag: "Research",
        document: `${exactDocument}a`,
      }),
    ).toThrow()
    expect(
      await Effect.runPromise(
        catalog.prepareOutput({
          contract: researchStageContract.ref,
          result: { _tag: "Research", document: "# Research" },
          context: { scope: researchScope, target },
        }),
      ),
    ).toEqual({ _tag: "Document", text: "# Research" })
  })
})

describe("exact Design contract through erased catalog execution", () => {
  test.each([
    ["Research and Questions", [designResearchSource, researchSource]],
    ["Research only", [designResearchSource]],
    ["Questions only", [researchSource]],
    ["no predecessors", []],
  ] as const)("accepts the enabled %s predecessor subsequence", async (_name, predecessors) => {
    const exactSources = {
      ...designSources,
      sources: predecessors,
      sourceSetSha256: canonicalSha256(
        predecessors.map(({ role, artifact }) => ({ role, artifact })),
      ),
    }
    const catalog = new TrustedStageCatalog([designStageContract]).port()

    const request = await Effect.runPromise(
      catalog.assembleRequest({
        contract: designStageContract.ref,
        sources: exactSources,
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )

    expect(Schema.decodeUnknownSync(DesignRequest)(request)).toEqual({
      _tag: "DesignRequest",
      sources: exactSources,
      designPolicy: { name: "qrspi.design-policy", version: 1 },
      promotionPolicy: { name: "qrspi.promotion-policy", version: 1 },
      structurePolicy: { name: "qrspi.structure-policy", version: 1 },
    })
  })

  test("rejects changed policy identity, predecessor order, and result substitution", async () => {
    const catalog = new TrustedStageCatalog([designStageContract]).port()
    const request = {
      _tag: "DesignRequest" as const,
      sources: designSources,
      designPolicy: { name: "qrspi.other-policy", version: 1 },
      promotionPolicy: { name: "qrspi.promotion-policy", version: 1 },
      structurePolicy: { name: "qrspi.structure-policy", version: 1 },
    }
    expect(() => Schema.decodeUnknownSync(DesignRequest)(request)).toThrow()
    const reversed = {
      ...designSources,
      sources: [researchSource, designResearchSource],
      sourceSetSha256: canonicalSha256([
        { role: "Questions", artifact: researchArtifact },
        { role: "Research", artifact: designResearchArtifact },
      ]),
    }
    expect(
      await Effect.runPromise(
        catalog
          .assembleRequest({
            contract: designStageContract.ref,
            sources: reversed,
            maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
    expect(
      await Effect.runPromise(
        catalog
          .prepareOutput({
            contract: designStageContract.ref,
            result: { _tag: "Research", document: "wrong" },
            context: { scope: designScope, target },
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_result" } })
  })

  test("keeps the Design result distinct and projects a bounded document", async () => {
    const catalog = new TrustedStageCatalog([designStageContract]).port()
    expect(
      Schema.decodeUnknownSync(DesignResult)({ _tag: "Design", document: "# Design" }),
    ).toEqual({ _tag: "Design", document: "# Design" })
    expect(
      await Effect.runPromise(
        catalog.prepareOutput({
          contract: designStageContract.ref,
          result: { _tag: "Design", document: "# Design" },
          context: { scope: designScope, target },
        }),
      ),
    ).toEqual({ _tag: "Document", text: "# Design" })
  })
})

describe("exact Structure contract through erased catalog execution", () => {
  test("keeps owner-issued Design authority separate from artifact roles", async () => {
    expect(Schema.decodeUnknownSync(StructureAuthority)(structureAuthority)).toEqual(
      structureAuthority,
    )
    const catalog = new TrustedStageCatalog([structureStageContract]).port()
    const request = await Effect.runPromise(
      catalog.assembleRequest({
        contract: structureStageContract.ref,
        sources: structureSources,
        local: { structureAuthority },
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )

    expect(Schema.decodeUnknownSync(StructureRequest)(request)).toEqual({
      _tag: "StructureRequest",
      sources: structureSources,
      structurePolicy: { name: "qrspi.structure-policy", version: 1 },
      authority: structureAuthority,
    })
    const task = await Effect.runPromise(
      catalog.buildTask({
        input: encodeStageProduceInput(structureScope, structureStageContract.ref, request),
        ticketRevision: verifiedTicket,
      }),
    )
    expect(task.authority).toEqual({
      ticketRevision,
      sources: [structureDesignSource, designResearchSource, researchSource],
    })
  })

  test.each([
    ["missing authority", undefined],
    [
      "cross-workflow package",
      {
        ...structureAuthority,
        acceptancePackage: {
          ...structureAuthority.acceptancePackage,
          workflowId: `wf_${sha("f")}`,
        },
      },
    ],
    [
      "cross-Generation graph",
      { ...structureAuthority, graph: { ...structureAuthority.graph, generation: 2 } },
    ],
    [
      "cross-repository graph",
      {
        ...structureAuthority,
        graph: {
          ...structureAuthority.graph,
          repository: { ...target.repository, repositoryId: "other" },
        },
      },
    ],
  ] as const)("rejects %s owner authority", (_name, authority) => {
    const value = {
      _tag: "StructureRequest",
      sources: structureSources,
      structurePolicy: { name: "qrspi.structure-policy", version: 1 },
      ...(authority === undefined ? {} : { authority }),
    }
    expect(() => Schema.decodeUnknownSync(StructureRequest)(value)).toThrow()
  })

  test("keeps the Structure result distinct and projects a document", async () => {
    const catalog = new TrustedStageCatalog([structureStageContract]).port()
    expect(
      Schema.decodeUnknownSync(StructureResult)({ _tag: "Structure", document: "# Structure" }),
    ).toEqual({ _tag: "Structure", document: "# Structure" })
    expect(() =>
      Schema.decodeUnknownSync(StructureResult)({ _tag: "Design", document: "# Structure" }),
    ).toThrow()
    expect(
      await Effect.runPromise(
        catalog.prepareOutput({
          contract: structureStageContract.ref,
          result: { _tag: "Structure", document: "# Structure" },
          context: { scope: structureScope, target },
        }),
      ),
    ).toEqual({ _tag: "Document", text: "# Structure" })
  })
})

describe("exact Plan contract through erased catalog execution", () => {
  test("assembles, rebuilds ordered authority, and prepares only Plan results", async () => {
    const catalog = new TrustedStageCatalog([planStageContract]).port()
    const request = await Effect.runPromise(
      catalog.assembleRequest({
        contract: planStageContract.ref,
        sources: planSources,
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )
    expect(Schema.decodeUnknownSync(PlanRequest)(request)).toEqual({
      _tag: "PlanRequest",
      sources: planSources,
    })
    const task = await Effect.runPromise(
      catalog.buildTask({
        input: encodeStageProduceInput(planScope, planStageContract.ref, request),
        ticketRevision: verifiedTicket,
      }),
    )
    expect(task.authority).toEqual({
      ticketRevision,
      sources: [planStructureSource, structureDesignSource, designResearchSource, researchSource],
    })
    expect(Schema.decodeUnknownSync(PlanResult)({ _tag: "Plan", document: "# Plan" })).toEqual({
      _tag: "Plan",
      document: "# Plan",
    })
    expect(
      await Effect.runPromise(
        catalog.prepareOutput({
          contract: planStageContract.ref,
          result: { _tag: "Plan", document: "# Plan" },
          context: { scope: planScope, target },
        }),
      ),
    ).toEqual({ _tag: "Document", text: "# Plan" })
    expect(
      await Effect.runPromise(
        catalog
          .prepareOutput({
            contract: planStageContract.ref,
            result: { _tag: "Structure", document: "wrong" },
            context: { scope: planScope, target },
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_result" } })
  })
})

describe("exact Implementation contract through erased catalog execution", () => {
  const nonFinal = {
    _tag: "PreparedCommit" as const,
    candidateCommitSha: "1".repeat(40),
    expectedParentSha: target.expectedParentSha,
    changedPaths: ["src/qrspi/contracts/implementation.ts"],
    final: false as const,
  }
  const final = {
    _tag: "PreparedFinalCommit" as const,
    candidateCommitSha: "2".repeat(40),
    expectedParentSha: target.expectedParentSha,
    changedPaths: ["src/qrspi/contracts/implementation.ts", "test/qrspi/contracts.test.ts"],
    final: true as const,
    scenarioEvidence: ["scenario: exact implementation contract passes"],
  }

  test("assembles all predecessors and preserves non-final and final prepared commits", async () => {
    const catalog = new TrustedStageCatalog([implementationStageContract]).port()
    const request = await Effect.runPromise(
      catalog.assembleRequest({
        contract: implementationStageContract.ref,
        sources: implementationSources,
        local: { checkpointPosition: 3 },
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )
    expect(Schema.decodeUnknownSync(ImplementationRequest)(request)).toEqual({
      _tag: "ImplementationRequest",
      sources: implementationSources,
      checkpointPosition: 3,
      expectedParentSha: target.expectedParentSha,
    })
    const task = await Effect.runPromise(
      catalog.buildTask({
        input: encodeStageProduceInput(
          implementationScope,
          implementationStageContract.ref,
          request,
        ),
        ticketRevision: verifiedTicket,
      }),
    )
    expect(task.authority).toEqual({
      ticketRevision,
      sources: implementationSources.sources,
    })
    for (const result of [nonFinal, final]) {
      expect(Schema.decodeUnknownSync(ImplementationResult)(result)).toEqual(result)
      expect(
        await Effect.runPromise(
          catalog.prepareOutput({
            contract: implementationStageContract.ref,
            result,
            context: { scope: implementationScope, target },
          }),
        ),
      ).toEqual({ _tag: "ImplementationStep", value: result })
    }
  })

  test("rejects parent, evidence, path, and result-kind substitutions", async () => {
    const catalog = new TrustedStageCatalog([implementationStageContract]).port()
    for (const result of [
      { ...nonFinal, expectedParentSha: "3".repeat(40) },
      { ...nonFinal, scenarioEvidence: ["forbidden"] },
      { ...final, scenarioEvidence: [] },
      { ...final, changedPaths: [] },
      { ...final, changedPaths: ["../outside"] },
      { _tag: "Plan", document: "wrong output kind" },
    ]) {
      expect(
        await Effect.runPromise(
          catalog
            .prepareOutput({
              contract: implementationStageContract.ref,
              result,
              context: { scope: implementationScope, target },
            })
            .pipe(Effect.either),
        ),
      ).toMatchObject({ _tag: "Left" })
    }
  })

  test("owns exact changed-path, evidence, and complete request boundaries", async () => {
    const exactPath = `src/${"a".repeat(508)}`
    expect(() =>
      Schema.decodeUnknownSync(ImplementationResult)({ ...nonFinal, changedPaths: [exactPath] }),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ImplementationResult)({
        ...nonFinal,
        changedPaths: [`${exactPath}a`],
      }),
    ).toThrow()
    const exactEvidence = "é".repeat(2_000)
    expect(() =>
      Schema.decodeUnknownSync(ImplementationResult)({
        ...final,
        scenarioEvidence: [exactEvidence],
      }),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ImplementationResult)({
        ...final,
        scenarioEvidence: [`${exactEvidence}a`],
      }),
    ).toThrow()
    expect(
      Buffer.byteLength(
        JSON.stringify({
          _tag: "ImplementationRequest",
          sources: implementationSources,
          checkpointPosition: Number.MAX_SAFE_INTEGER,
          expectedParentSha: target.expectedParentSha,
        }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(MAX_STAGE_REQUEST_BYTES)
  })
})
