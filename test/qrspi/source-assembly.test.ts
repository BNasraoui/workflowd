import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  AcceptedPredecessorPointer,
  ArtifactReference,
  ExactArtifactSource,
  compareAcceptedPredecessorCurrentness,
} from "../../src/qrspi/contracts"
import {
  canonicalSha256,
  stageDefinitionSha256,
  workflowDefinitionSha256,
  type ExecutableStageSnapshot,
  type StageDefinition,
  type WorkflowDefinition,
} from "../../src/qrspi/domain"
import { QrspiRepositoryError, type QrspiRepositoryPort } from "../../src/qrspi/ports"
import { assembleExactStageSources } from "../../src/qrspi/source-assembly"

const sha = (character: string) => character.repeat(64)
const gitSha = (character: string) => character.repeat(40)

const artifact = {
  repository: {
    providerInstanceId: "github-app-1",
    repositoryId: "repository-1",
    repositoryFullName: "owner/repository",
  },
  workflowId: `wf_${sha("a")}`,
  generation: 2,
  stageKey: "questions",
  stageRevision: 3,
  commitSha: gitSha("b"),
  path: "artifacts/questions.md",
  blobSha: gitSha("c"),
  contentSha256: createHash("sha256").update("# Questions").digest("hex"),
  mediaType: "text/markdown",
}

const pointerIdentity = {
  role: "Questions" as const,
  snapshotSha256: sha("e"),
  runOrdinal: 4,
  acceptedStageRevision: 3,
  targetParentSha: gitSha("f"),
  contract: { name: "qrspi.questions", contractVersion: 1 },
  contractRegistrationSha256: sha("1"),
  artifact,
}
const pointer = { ...pointerIdentity, pointerSha256: canonicalSha256(pointerIdentity) }

describe("exact artifact authority", () => {
  test("decodes an exact artifact source and accepted predecessor pointer", () => {
    expect(Schema.decodeUnknownSync(ArtifactReference)(artifact)).toEqual(artifact)
    expect(
      Schema.decodeUnknownSync(ExactArtifactSource)({
        role: "Questions",
        artifact,
        acceptedPointer: pointer,
        content: "# Questions",
      }),
    ).toEqual({ role: "Questions", artifact, acceptedPointer: pointer, content: "# Questions" })
    expect(Schema.decodeUnknownSync(AcceptedPredecessorPointer)(pointer)).toEqual(pointer)
  })

  test.each([
    ["generation", { artifact: { ...artifact, generation: 3 } }],
    ["snapshot", { snapshotSha256: sha("2") }],
    ["run_ordinal", { runOrdinal: 5 }],
    ["stage_revision", { artifact: { ...artifact, stageRevision: 4 } }],
    ["target_parent", { targetParentSha: gitSha("2") }],
    ["contract", { contract: { name: "qrspi.other", contractVersion: 1 } }],
    ["pointer_identity", { artifact: { ...artifact, path: "artifacts/other.md" } }],
  ] as const)("reports hash-valid %s currentness mismatches", (reason, change) => {
    const actual = {
      ...pointer,
      ...change,
      pointerSha256: canonicalSha256({ ...pointer, ...change }),
    }
    const expected = { ...pointer, pointerSha256: canonicalSha256(pointer) }

    expect(compareAcceptedPredecessorCurrentness(expected, actual, 0)).toMatchObject({
      _tag: "StageSourceCurrentnessMismatch",
      reason,
      role: "Questions",
      index: 0,
    })
  })

  test("does not accept Structure owner authority as a generic artifact role", () => {
    const identity = { ...pointerIdentity, role: "DesignAcceptancePackage" }
    expect(() =>
      Schema.decodeUnknownSync(AcceptedPredecessorPointer)({
        ...identity,
        pointerSha256: canonicalSha256(identity),
      }),
    ).toThrow()
  })
})

const stage = (key: "questions" | "research", enabled = true): StageDefinition => ({
  key,
  kind: "document",
  contract: { name: `qrspi.${key}`, contractVersion: 1 },
  activation: { mode: enabled ? "enabled" : "disabled" },
  definitionVersion: 1,
  maxEncodedInputBytes: 32 * 1024,
  producer: {
    harness: { name: "opencode", version: 1 },
    agent: `${key}-agent`,
    model: "openai/gpt-5.6-sol",
    timeoutMs: 1_000,
    retry: { maxAttempts: 1, backoffMs: 1 },
  },
  outputPolicy: {
    _tag: "Artifact",
    pathTemplate: `artifacts/${key}.md`,
    mediaType: "text/markdown",
  },
  reviewPolicy: { mode: "none" },
  humanGatePolicy: { mode: "none" },
})

const questionsDefinition = stage("questions")
const researchDefinition = stage("research")
const workflowDefinition: WorkflowDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [questionsDefinition, researchDefinition],
}
const snapshots: ReadonlyArray<ExecutableStageSnapshot> = [
  {
    sequencePosition: 1,
    stageDefinitionSha256: stageDefinitionSha256(questionsDefinition),
    definition: questionsDefinition,
    contractRegistrationSha256: sha("1"),
    harnessRegistrationSha256: sha("2"),
  },
  {
    sequencePosition: 2,
    stageDefinitionSha256: stageDefinitionSha256(researchDefinition),
    definition: researchDefinition,
    contractRegistrationSha256: sha("3"),
    harnessRegistrationSha256: sha("4"),
  },
]
const sourceContent = "# Questions"
const sourceArtifact = {
  ...artifact,
  contentSha256: createHash("sha256").update(sourceContent).digest("hex"),
}
const acceptedIdentity = {
  ...pointerIdentity,
  snapshotSha256: snapshots[0]!.stageDefinitionSha256,
  acceptedStageRevision: sourceArtifact.stageRevision,
  artifact: sourceArtifact,
}
const acceptedPointer = {
  ...acceptedIdentity,
  pointerSha256: canonicalSha256(acceptedIdentity),
}
const selectedScope = {
  workflowId: sourceArtifact.workflowId,
  generation: sourceArtifact.generation,
  stageKey: "research",
  runOrdinal: 1,
  stageRevision: 1,
  workflowDefinitionSha256: workflowDefinitionSha256(workflowDefinition),
  stageDefinitionSha256: snapshots[1]!.stageDefinitionSha256,
}
const target = {
  repository: sourceArtifact.repository,
  headRef: "workflow/topic",
  expectedParentSha: acceptedPointer.targetParentSha,
}
const ticketRevision = {
  workflowId: selectedScope.workflowId,
  ticketRevisionSha256: sha("6"),
}

function repositoryReader(
  observation: Partial<{
    commitSha: string
    path: string
    blobSha: string
    bytes: Uint8Array
  }> = {},
) {
  let calls = 0
  const port: QrspiRepositoryPort = {
    readArtifact: () => {
      calls += 1
      return Effect.succeed({
        commitSha: sourceArtifact.commitSha,
        path: sourceArtifact.path,
        blobSha: sourceArtifact.blobSha,
        bytes: new TextEncoder().encode(sourceContent),
        ...observation,
      })
    },
    inspect: () => Effect.die("unused"),
    hasOpenPullRequest: () => Effect.die("unused"),
    observeBranch: () => Effect.die("unused"),
    observeAcceptedBranch: () => Effect.die("unused"),
    createBranch: () => Effect.die("unused"),
  }
  return { port, calls: () => calls }
}

const assemblyInput = (
  repository: QrspiRepositoryPort,
  pointers: ReadonlyArray<unknown> = [acceptedPointer],
) => ({
  scope: selectedScope,
  ticketRevision,
  target,
  workflowDefinition,
  snapshots,
  acceptedPointers: pointers,
  maxSourceBytes: 32 * 1024,
  repository,
})

describe("trusted Research source assembly", () => {
  test("assembles one accepted Questions artifact in canonical authority order", async () => {
    const reader = repositoryReader()

    const result = await Effect.runPromise(assembleExactStageSources(assemblyInput(reader.port)))

    const expectedSource = {
      role: "Questions" as const,
      artifact: sourceArtifact,
      acceptedPointer,
      content: sourceContent,
    }
    expect(result.sources).toEqual([expectedSource])
    expect(result.sourceSetSha256).toBe(
      canonicalSha256([{ role: "Questions", artifact: sourceArtifact }]),
    )
    expect(reader.calls()).toBe(1)
  })

  test("preserves revision intent in assembled exact sources", async () => {
    const reader = repositoryReader()
    const revisionIntent = { reason: "Address requested review changes" }

    const result = await Effect.runPromise(
      assembleExactStageSources({ ...assemblyInput(reader.port), revisionIntent }),
    )

    expect(result.revisionIntent).toEqual(revisionIntent)
  })

  test("rejects snapshots labeled with a different rehashed workflow definition before I/O", async () => {
    const reader = repositoryReader()
    const differentDefinition: WorkflowDefinition = {
      ...workflowDefinition,
      definitionVersion: 2,
    }
    const result = await Effect.runPromise(
      assembleExactStageSources({
        ...assemblyInput(reader.port),
        scope: {
          ...selectedScope,
          workflowDefinitionSha256: workflowDefinitionSha256(differentDefinition),
        },
      }).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "StageSourceAssemblyError", reason: "selected_snapshot_mismatch" },
    })
    expect(reader.calls()).toBe(0)
  })

  test("preserves a leading UTF-8 BOM in exact source content", async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(sourceContent)])
    const bomArtifact = {
      ...sourceArtifact,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    }
    const bomIdentity = { ...acceptedIdentity, artifact: bomArtifact }
    const bomPointer = {
      ...bomIdentity,
      pointerSha256: canonicalSha256(bomIdentity),
    }
    const reader = repositoryReader({ bytes })

    const result = await Effect.runPromise(
      assembleExactStageSources(assemblyInput(reader.port, [bomPointer])),
    )

    expect(result.sources[0]?.content).toBe(`\ufeff${sourceContent}`)
  })

  test("uses stable repository IDs while allowing a locator rename", async () => {
    const reader = repositoryReader()
    const renamedTarget = {
      ...target,
      repository: { ...target.repository, repositoryFullName: "renamed/repository" },
    }

    const result = await Effect.runPromise(
      assembleExactStageSources({ ...assemblyInput(reader.port), target: renamedTarget }),
    )

    expect(result.sources).toHaveLength(1)
    expect(reader.calls()).toBe(1)
  })

  test.each([
    ["missing pointer", []],
    ["extra pointer", [acceptedPointer, acceptedPointer]],
    ["wrong role", [{ role: "Research" }]],
    [
      "wrong repository",
      [
        {
          artifact: {
            ...sourceArtifact,
            repository: { ...sourceArtifact.repository, repositoryId: "other" },
          },
        },
      ],
    ],
    ["wrong workflow", [{ artifact: { ...sourceArtifact, workflowId: `wf_${sha("9")}` } }]],
    ["wrong generation", [{ artifact: { ...sourceArtifact, generation: 3 } }]],
    ["wrong stage", [{ artifact: { ...sourceArtifact, stageKey: "research" } }]],
    ["wrong accepted revision", [{ acceptedStageRevision: 2 }]],
    ["wrong snapshot", [{ snapshotSha256: sha("9") }]],
    ["wrong target parent", [{ targetParentSha: gitSha("9") }]],
    ["wrong contract", [{ contract: { name: "qrspi.research", contractVersion: 1 } }]],
  ] as const)("rejects %s before repository I/O", async (_name, changes) => {
    const reader = repositoryReader()
    const pointers = changes.map((change) => {
      const identity = { ...acceptedIdentity, ...change }
      return { ...identity, pointerSha256: canonicalSha256(identity) }
    })

    const result = await Effect.runPromise(
      assembleExactStageSources(assemblyInput(reader.port, pointers)).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "StageSourceAssemblyError" },
    })
    expect(reader.calls()).toBe(0)
  })

  test("allows no Questions pointer when Questions is disabled", async () => {
    const reader = repositoryReader()
    const disabledQuestions = stage("questions", false)
    const disabledSnapshots = [
      {
        ...snapshots[0]!,
        definition: disabledQuestions,
        stageDefinitionSha256: stageDefinitionSha256(disabledQuestions),
      },
      snapshots[1]!,
    ]
    const disabledWorkflowDefinition = {
      ...workflowDefinition,
      stages: [disabledQuestions, researchDefinition],
    }

    const result = await Effect.runPromise(
      assembleExactStageSources({
        ...assemblyInput(reader.port, []),
        workflowDefinition: disabledWorkflowDefinition,
        scope: {
          ...selectedScope,
          workflowDefinitionSha256: workflowDefinitionSha256(disabledWorkflowDefinition),
        },
        snapshots: disabledSnapshots,
      }),
    )

    expect(result.sources).toEqual([])
    expect(reader.calls()).toBe(0)
  })

  test.each([
    ["commit", { commitSha: gitSha("9") }],
    ["path", { path: "artifacts/other.md" }],
    ["blob", { blobSha: gitSha("9") }],
    ["UTF-8", { bytes: Uint8Array.from([0xc3, 0x28]) }],
    ["content hash", { bytes: new TextEncoder().encode("changed") }],
  ] as const)("rejects an observed %s mismatch", async (_name, observation) => {
    const reader = repositoryReader(observation)

    const result = await Effect.runPromise(
      assembleExactStageSources(assemblyInput(reader.port)).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "StageSourceAssemblyError", role: "Questions", index: 0 },
    })
    expect(reader.calls()).toBe(1)
  })

  test("preserves typed repository read failures", async () => {
    const reader = repositoryReader()
    const failingPort = {
      ...reader.port,
      readArtifact: () =>
        Effect.fail(
          new QrspiRepositoryError({ operation: "read", cause: new Error("one byte over") }),
        ),
    }

    expect(
      await Effect.runPromise(
        assembleExactStageSources(assemblyInput(failingPort)).pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { _tag: "QrspiRepositoryError" } })
  })
})

describe("generalized document predecessor assembly through Plan", () => {
  const keys = ["questions", "research", "design", "structure"] as const
  const roles = {
    questions: "Questions",
    research: "Research",
    design: "Design",
    structure: "Structure",
  } as const
  const planStage = (key: (typeof keys)[number] | "plan", enabled: boolean): StageDefinition => ({
    ...stage(key === "plan" ? "research" : key === "questions" ? "questions" : "research", enabled),
    key,
    contract: { name: `qrspi.${key}`, contractVersion: 1 },
    producer: {
      ...stage("research", enabled).producer,
      agent: `${key}-agent`,
    },
    outputPolicy: {
      _tag: "Artifact",
      pathTemplate: `artifacts/${key}.md`,
      mediaType: "text/markdown",
    },
  })

  const matrixInput = (enabled: ReadonlyArray<boolean>) => {
    const definitions = [
      ...keys.map((key, index) => planStage(key, enabled[index]!)),
      planStage("plan", true),
    ]
    const matrixSnapshots = definitions.map((definition, index) => ({
      sequencePosition: index + 1,
      stageDefinitionSha256: stageDefinitionSha256(definition),
      definition,
      contractRegistrationSha256: sha(String(index + 1)),
      harnessRegistrationSha256: sha(String(index + 5)),
    }))
    const matrixWorkflowDefinition: WorkflowDefinition = {
      contractVersion: 1,
      definitionVersion: 1,
      stages: definitions,
    }
    const artifacts = keys.map((key, index) => {
      const content = `# ${roles[key]}`
      return {
        repository: artifact.repository,
        workflowId: artifact.workflowId,
        generation: artifact.generation,
        stageKey: key,
        stageRevision: index + 1,
        commitSha: gitSha(String(index + 1)),
        path: `artifacts/${key}.md`,
        blobSha: gitSha(String(index + 5)),
        contentSha256: createHash("sha256").update(content).digest("hex"),
        mediaType: "text/markdown",
      }
    })
    const pointers = keys
      .map((key, index) => ({ key, index, enabled: enabled[index]! }))
      .filter(({ enabled }) => enabled)
      .reverse()
      .map(({ key, index }) => {
        const identity = {
          role: roles[key],
          snapshotSha256: matrixSnapshots[index]!.stageDefinitionSha256,
          runOrdinal: 1,
          acceptedStageRevision: artifacts[index]!.stageRevision,
          targetParentSha: gitSha("f"),
          contract: matrixSnapshots[index]!.definition.contract,
          contractRegistrationSha256: matrixSnapshots[index]!.contractRegistrationSha256,
          artifact: artifacts[index]!,
        }
        return { ...identity, pointerSha256: canonicalSha256(identity) }
      })
    let calls = 0
    const repository: QrspiRepositoryPort = {
      readArtifact: ({ path }) => {
        calls += 1
        const source = artifacts.find((candidate) => candidate.path === path)!
        return Effect.succeed({
          commitSha: source.commitSha,
          path: source.path,
          blobSha: source.blobSha,
          bytes: new TextEncoder().encode(`# ${roles[source.stageKey]}`),
        })
      },
      inspect: () => Effect.die("unused"),
      hasOpenPullRequest: () => Effect.die("unused"),
      observeBranch: () => Effect.die("unused"),
      observeAcceptedBranch: () => Effect.die("unused"),
      createBranch: () => Effect.die("unused"),
    }
    return {
      input: {
        scope: {
          ...selectedScope,
          stageKey: "plan",
          workflowDefinitionSha256: workflowDefinitionSha256(matrixWorkflowDefinition),
          stageDefinitionSha256: matrixSnapshots[4]!.stageDefinitionSha256,
        },
        ticketRevision,
        target: { ...target, expectedParentSha: gitSha("f") },
        workflowDefinition: matrixWorkflowDefinition,
        snapshots: matrixSnapshots,
        acceptedPointers: pointers,
        maxSourceBytes: 32 * 1024,
        repository,
      },
      pointers,
      calls: () => calls,
    }
  }

  test.each(Array.from({ length: 16 }, (_, mask) => mask))(
    "assembles enabled predecessor subsequence mask %i in newest-to-oldest order",
    async (mask) => {
      const enabled = keys.map((_, index) => (mask & (1 << index)) !== 0)
      const fixture = matrixInput(enabled)
      const result = await Effect.runPromise(assembleExactStageSources(fixture.input))
      expect(result.sources.map(({ role }) => role)).toEqual(
        keys
          .filter((_, index) => enabled[index])
          .map((key) => roles[key])
          .reverse(),
      )
      expect(fixture.calls()).toBe(result.sources.length)
    },
  )

  test.each([
    [
      "role",
      (pointers: Array<typeof AcceptedPredecessorPointer.Type>) => [
        { ...pointers[0]!, role: "Design" as const },
        ...pointers.slice(1),
      ],
    ],
    [
      "accepted revision",
      (pointers: Array<typeof AcceptedPredecessorPointer.Type>) => [
        { ...pointers[0]!, acceptedStageRevision: pointers[0]!.acceptedStageRevision + 1 },
        ...pointers.slice(1),
      ],
    ],
    [
      "order",
      (pointers: Array<typeof AcceptedPredecessorPointer.Type>) => [
        pointers[1]!,
        pointers[0]!,
        ...pointers.slice(2),
      ],
    ],
  ])("rejects one-at-a-time %s substitution before I/O", async (_name, mutate) => {
    const fixture = matrixInput([true, true, true, true])
    const changed = mutate([...fixture.pointers]).map(({ pointerSha256: _, ...identity }) => ({
      ...identity,
      pointerSha256: canonicalSha256(identity),
    }))
    const result = await Effect.runPromise(
      assembleExactStageSources({ ...fixture.input, acceptedPointers: changed }).pipe(
        Effect.either,
      ),
    )
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "StageSourceAssemblyError" } })
    expect(fixture.calls()).toBe(0)
  })
})

describe("Implementation predecessor assembly", () => {
  test("assembles the enabled Plan through Questions subsequence", async () => {
    const keys = ["questions", "research", "design", "structure", "plan"] as const
    const roles = ["Questions", "Research", "Design", "Structure", "Plan"] as const
    const definitions = [
      ...keys.map((key) => ({
        ...stage(key === "questions" ? "questions" : "research"),
        key,
        contract: { name: `qrspi.${key}`, contractVersion: 1 },
      })),
      {
        ...stage("research"),
        key: "implementation",
        kind: "implementation" as const,
        contract: { name: "qrspi.implementation", contractVersion: 1 },
        outputPolicy: {
          _tag: "ImplementationCheckpoint" as const,
          contractId: "qrspi.implementation-checkpoint",
          contractVersion: 1,
        },
      },
    ]
    const implementationSnapshots = definitions.map((definition, index) => ({
      sequencePosition: index + 1,
      stageDefinitionSha256: stageDefinitionSha256(definition),
      definition,
      contractRegistrationSha256: sha(String(index + 1)),
      harnessRegistrationSha256: sha(String(index + 2)),
    }))
    const implementationWorkflowDefinition: WorkflowDefinition = {
      contractVersion: 1,
      definitionVersion: 1,
      stages: definitions,
    }
    const artifacts = keys.map((key, index) => {
      const content = `# ${roles[index]}`
      return {
        ...artifact,
        stageKey: key,
        stageRevision: index + 1,
        path: `artifacts/${key}.md`,
        commitSha: gitSha(String(index + 1)),
        blobSha: gitSha(String(index + 2)),
        contentSha256: createHash("sha256").update(content).digest("hex"),
      }
    })
    const pointers = keys
      .map((key, index) => {
        const identity = {
          role: roles[index],
          snapshotSha256: implementationSnapshots[index]!.stageDefinitionSha256,
          runOrdinal: 1,
          acceptedStageRevision: artifacts[index]!.stageRevision,
          targetParentSha: gitSha("f"),
          contract: implementationSnapshots[index]!.definition.contract,
          contractRegistrationSha256: implementationSnapshots[index]!.contractRegistrationSha256,
          artifact: artifacts[index]!,
        }
        return { ...identity, pointerSha256: canonicalSha256(identity) }
      })
      .reverse()
    let calls = 0
    const repository: QrspiRepositoryPort = {
      ...repositoryReader().port,
      readArtifact: ({ path }) => {
        calls += 1
        const source = artifacts.find((candidate) => candidate.path === path)!
        const index = artifacts.indexOf(source)
        return Effect.succeed({
          commitSha: source.commitSha,
          path,
          blobSha: source.blobSha,
          bytes: new TextEncoder().encode(`# ${roles[index]}`),
        })
      },
    }
    const result = await Effect.runPromise(
      assembleExactStageSources({
        scope: {
          ...selectedScope,
          stageKey: "implementation",
          workflowDefinitionSha256: workflowDefinitionSha256(implementationWorkflowDefinition),
          stageDefinitionSha256: implementationSnapshots[5]!.stageDefinitionSha256,
        },
        ticketRevision,
        target: { ...target, expectedParentSha: gitSha("f") },
        workflowDefinition: implementationWorkflowDefinition,
        snapshots: implementationSnapshots,
        acceptedPointers: pointers,
        maxSourceBytes: 32 * 1024,
        repository,
      }),
    )
    expect(result.sources.map(({ role }) => role)).toEqual([...roles].reverse())
    expect(calls).toBe(5)
  })
})
