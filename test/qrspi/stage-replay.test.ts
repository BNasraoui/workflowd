import { afterEach, describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  TicketRevision,
  ticketRevisionSha256For,
  type TicketRevision as TicketRevisionType,
  workflowIdFor,
} from "../../src/qrspi/domain"
import { QrspiStore, QrspiStoreLive } from "../../src/qrspi/store"
import {
  builtInStageContracts,
  encodeStageProduceInput,
  researchStageContract,
  type AcceptedPredecessorPointer,
  type ArtifactReference,
  type ExactStageScope,
} from "../../src/qrspi/contracts"
import { TrustedStageCatalog } from "../../src/qrspi/stage-catalog"
import { canonicalSha256 } from "../../src/qrspi/domain"

const directories: string[] = []
const repository = {
  providerInstanceId: "github-app-1",
  repositoryId: "repository-1",
  repositoryFullName: "owner/repository",
}
const ticketReference = {
  tracker: "beads" as const,
  trackerInstanceId: "workspace-42",
  nativeTicketId: "workflowd-vs3.4.2",
}
const workflowId = workflowIdFor(repository, ticketReference)

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function ticketRevision(): TicketRevisionType {
  const readyTicket = {
    reference: {
      ...ticketReference,
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

function replayAuthorityFor(
  contract: (typeof builtInStageContracts)[number],
  sources: ExactStageScope & {
    readonly stageKey: string
    readonly stageDefinitionSha256: string
    readonly sources: ReadonlyArray<{
      readonly acceptedPointer: AcceptedPredecessorPointer
      readonly artifact: ArtifactReference
    }>
  },
  maxEncodedInputBytes = contract.maxRequestBytes,
) {
  const catalog = new TrustedStageCatalog(builtInStageContracts)
  return {
    scope: {
      workflowId: sources.workflowId,
      generation: sources.generation,
      stageKey: sources.stageKey,
      runOrdinal: sources.runOrdinal,
      stageRevision: sources.stageRevision,
      workflowDefinitionSha256: sources.workflowDefinitionSha256,
      stageDefinitionSha256: sources.stageDefinitionSha256,
    },
    stageSnapshot: {
      stageKey: sources.stageKey,
      stageDefinitionSha256: sources.stageDefinitionSha256,
      contract: contract.ref,
      contractRegistrationSha256: catalog.descriptor(contract.ref).registrationSha256,
      maxEncodedInputBytes,
    },
    predecessorSnapshots: sources.sources.map(({ acceptedPointer, artifact }) => ({
      stageKey: artifact.stageKey,
      stageDefinitionSha256: acceptedPointer.snapshotSha256,
      contract: acceptedPointer.contract,
      contractRegistrationSha256: acceptedPointer.contractRegistrationSha256,
    })),
    acceptedPointers: sources.sources.map(({ acceptedPointer }) => acceptedPointer),
  }
}

type Mutation = "valid" | "missing" | "malformed" | "nested_hash" | "semantic" | "wrong_workflow"

async function readMutation(mutation: Mutation) {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-stage-replay-"))
  directories.push(directory)
  const filename = join(directory, "workflowd.db")
  const database = SqliteClient.layer({ filename })
  const storeLayer = QrspiStoreLive.pipe(Layer.provideMerge(database))
  const original = ticketRevision()
  const nestedHash = "b".repeat(64)
  const revisionJson =
    mutation === "malformed"
      ? JSON.stringify({ malformed: true })
      : JSON.stringify(
          mutation === "nested_hash"
            ? { ...original, ticketRevisionSha256: nestedHash }
            : mutation === "semantic"
              ? {
                  ...original,
                  readyTicket: { ...original.readyTicket, title: "Substituted product title" },
                }
              : original,
        )

  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* QrspiStore
      if (mutation !== "missing") {
        yield* sql`
          INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
          VALUES (${workflowId}, ${"workflow/test"}, ${"2026-07-24T00:00:00.000Z"}, ${"2026-07-24T00:00:00.000Z"})
        `
        yield* sql`
          INSERT INTO qrspi_ticket_revisions (
            workflow_id, ticket_revision_sha256, revision_json, checked_at
          ) VALUES (
            ${workflowId}, ${original.ticketRevisionSha256}, ${revisionJson},
            ${"2026-07-24T00:00:00.000Z"}
          )
        `
      }
      return yield* store
        .readTicketRevision({
          workflowId: mutation === "wrong_workflow" ? `wf_${"f".repeat(64)}` : workflowId,
          ticketRevisionSha256: original.ticketRevisionSha256,
        })
        .pipe(Effect.either)
    }).pipe(Effect.provide(storeLayer)),
  )
}

describe("exact immutable ticket revision replay", () => {
  test("reads the exact workflow and ticket hash row", async () => {
    const result = await readMutation("valid")
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") expect(result.right).toEqual(ticketRevision())
  })

  test.each([
    ["missing", "missing"],
    ["malformed", "malformed"],
    ["nested_hash", "identity_mismatch"],
    ["semantic", "hash_mismatch"],
    ["wrong_workflow", "missing"],
  ] as const)("classifies %s ticket rows as %s", async (mutation, reason) => {
    const result = await readMutation(mutation)
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "QrspiStoreDataError", record: "ticket_revision", reason },
    })
  })
})

describe("Research request replay", () => {
  test("rebuilds from persisted technical content without repository rediscovery", async () => {
    let repositoryCalls = 0
    const original = ticketRevision()
    const scope = {
      workflowId,
      generation: 1,
      stageKey: "research",
      runOrdinal: 1,
      stageRevision: 1,
      workflowDefinitionSha256: "b".repeat(64),
      stageDefinitionSha256: "c".repeat(64),
    }
    const content = "persisted questio\u0301ns"
    const artifact = {
      repository,
      workflowId,
      generation: 1,
      stageKey: "questions",
      stageRevision: 1,
      commitSha: "d".repeat(40),
      path: "artifacts/questions.md",
      blobSha: "e".repeat(40),
      contentSha256: createHash("sha256").update(content).digest("hex"),
      mediaType: "text/markdown",
    }
    const target = {
      repository: artifact.repository,
      headRef: "workflow/topic",
      expectedParentSha: "1".repeat(40),
    }
    const acceptedIdentity = {
      role: "Questions" as const,
      snapshotSha256: "2".repeat(64),
      runOrdinal: 1,
      acceptedStageRevision: artifact.stageRevision,
      targetParentSha: target.expectedParentSha,
      contract: { name: "qrspi.questions", contractVersion: 1 },
      contractRegistrationSha256: new TrustedStageCatalog(builtInStageContracts).descriptor({
        name: "qrspi.questions",
        contractVersion: 1,
      }).registrationSha256,
      artifact,
    }
    const source = {
      role: "Questions" as const,
      artifact,
      acceptedPointer: {
        ...acceptedIdentity,
        pointerSha256: canonicalSha256(acceptedIdentity),
      },
      content,
    }
    const sources = {
      ...scope,
      ticketRevision: { workflowId, ticketRevisionSha256: original.ticketRevisionSha256 },
      sources: [source],
      sourceSetSha256: canonicalSha256([{ role: "Questions", artifact }]),
      target,
      revisionIntent: { reason: "Revise the accepted Research output" },
    }
    const persisted = JSON.parse(
      JSON.stringify(
        encodeStageProduceInput(scope, researchStageContract.ref, {
          _tag: "ResearchRequest",
          sources,
        }),
      ),
    )
    const repositoryThatMustNotRun = () => {
      repositoryCalls += 1
      throw new Error("repository reread during replay")
    }
    void repositoryThatMustNotRun

    const task = await Effect.runPromise(
      new TrustedStageCatalog(builtInStageContracts).port().buildTask({
        input: persisted,
        ticketRevision: original,
        replayAuthority: replayAuthorityFor(researchStageContract, sources),
      }),
    )

    expect(task.authority.sources).toEqual([source])
    expect(task.authority.revisionIntent).toEqual({
      reason: "Revise the accepted Research output",
    })
    expect(persisted.request.sources.revisionIntent).toEqual({
      reason: "Revise the accepted Research output",
    })
    expect(repositoryCalls).toBe(0)

    const ticketFromAnotherWorkflow = Schema.decodeUnknownSync(TicketRevision)({
      ...original,
      readyTicket: {
        ...original.readyTicket,
        reference: { ...original.readyTicket.reference, nativeTicketId: "another-ticket" },
      },
    })
    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input: persisted,
            ticketRevision: ticketFromAnotherWorkflow,
            replayAuthority: replayAuthorityFor(researchStageContract, sources),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })

    const forgedIdentity = {
      ...source.acceptedPointer,
      snapshotSha256: "f".repeat(64),
      contractRegistrationSha256: "e".repeat(64),
      pointerSha256: undefined,
    }
    const { pointerSha256: _, ...forgedPointerIdentity } = forgedIdentity
    const forgedSource = {
      ...source,
      acceptedPointer: {
        ...forgedPointerIdentity,
        pointerSha256: canonicalSha256(forgedPointerIdentity),
      },
    }
    const forgedSources = { ...sources, sources: [forgedSource] }
    const forgedInput = encodeStageProduceInput(scope, researchStageContract.ref, {
      _tag: "ResearchRequest",
      sources: forgedSources,
    })
    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input: forgedInput,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(researchStageContract, sources),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })

    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input: persisted,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(
              researchStageContract,
              sources,
              Buffer.byteLength(JSON.stringify(persisted.request), "utf8") - 1,
            ),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "request_too_large" } })

    for (const substitutedContent of ["substituted questions", content.normalize("NFC")]) {
      const substitutedRequest = {
        _tag: "ResearchRequest" as const,
        sources: {
          ...sources,
          sources: [{ ...source, content: substitutedContent }],
        },
      }
      const substituted = encodeStageProduceInput(
        scope,
        researchStageContract.ref,
        substitutedRequest,
      )

      expect(
        await Effect.runPromise(
          new TrustedStageCatalog(builtInStageContracts)
            .port()
            .buildTask({
              input: substituted,
              ticketRevision: original,
              replayAuthority: replayAuthorityFor(
                researchStageContract,
                substitutedRequest.sources,
              ),
            })
            .pipe(Effect.either),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
    }

    const decomposedPath = "artifacts/e\u0301.md"
    const composedPath = decomposedPath.normalize("NFC")
    const pointerArtifact = { ...artifact, path: decomposedPath }
    const pointerIdentity = { ...acceptedIdentity, artifact: pointerArtifact }
    const pathSubstitutedSource = {
      ...source,
      artifact: { ...artifact, path: composedPath },
      acceptedPointer: {
        ...pointerIdentity,
        pointerSha256: canonicalSha256(pointerIdentity),
      },
    }
    const pathSubstitutedSources = {
      ...sources,
      sources: [pathSubstitutedSource],
      sourceSetSha256: canonicalSha256([
        { role: "Questions", artifact: pathSubstitutedSource.artifact },
      ]),
    }
    const pathSubstituted = encodeStageProduceInput(scope, researchStageContract.ref, {
      _tag: "ResearchRequest",
      sources: pathSubstitutedSources,
    })

    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input: pathSubstituted,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(researchStageContract, pathSubstitutedSources),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
  })
})

describe("complete built-in contract replay", () => {
  const original = ticketRevision()
  const target = {
    repository: {
      providerInstanceId: "github-app-1",
      repositoryId: "repository-1",
      repositoryFullName: "owner/repository",
    },
    headRef: "workflow/replay",
    expectedParentSha: "d".repeat(40),
  }
  const sourcesFor = (stageKey: string) => {
    const base = {
      workflowId,
      generation: 1,
      stageKey,
      runOrdinal: 1,
      stageRevision: 1,
      workflowDefinitionSha256: "b".repeat(64),
      stageDefinitionSha256: canonicalSha256({ stageKey }),
      ticketRevision: { workflowId, ticketRevisionSha256: original.ticketRevisionSha256 },
      sources: [] as const,
      sourceSetSha256: canonicalSha256([]),
      target,
    }
    if (stageKey !== "structure") return base
    const content = "# Accepted Design"
    const artifact = {
      repository: target.repository,
      workflowId,
      generation: 1,
      stageKey: "design",
      stageRevision: 1,
      commitSha: "6".repeat(40),
      path: "artifacts/design.md",
      blobSha: "7".repeat(40),
      contentSha256: createHash("sha256").update(content).digest("hex"),
      mediaType: "text/markdown",
    }
    const identity = {
      role: "Design" as const,
      snapshotSha256: "8".repeat(64),
      runOrdinal: 1,
      acceptedStageRevision: 1,
      targetParentSha: target.expectedParentSha,
      contract: { name: "qrspi.design", contractVersion: 1 },
      contractRegistrationSha256: new TrustedStageCatalog(builtInStageContracts).descriptor({
        name: "qrspi.design",
        contractVersion: 1,
      }).registrationSha256,
      artifact,
    }
    const source = {
      role: "Design" as const,
      artifact,
      acceptedPointer: { ...identity, pointerSha256: canonicalSha256(identity) },
      content,
    }
    return {
      ...base,
      sources: [source],
      sourceSetSha256: canonicalSha256([{ role: "Design", artifact }]),
    }
  }
  const structureAuthority = {
    acceptancePackage: {
      workflowId,
      generation: 1,
      designStageRevision: 1,
      packageSha256: "1".repeat(64),
    },
    gateResponse: {
      workflowId,
      generation: 1,
      designStageRevision: 1,
      packageSha256: "1".repeat(64),
      responseSha256: "2".repeat(64),
    },
    promotionResult: {
      workflowId,
      generation: 1,
      designStageRevision: 1,
      packageSha256: "1".repeat(64),
      gateResponseSha256: "2".repeat(64),
      resultSha256: "3".repeat(64),
    },
    graph: {
      repository: target.repository,
      workflowId,
      generation: 1,
      commitSha: "4".repeat(40),
      scope: "replay",
      graphSha256: "5".repeat(64),
    },
  }
  const fixtures = [
    {
      stageKey: "questions",
      request: (sources: ReturnType<typeof sourcesFor>) => ({
        _tag: "QuestionsRequest",
        sources,
      }),
      result: { _tag: "Questions", document: "# Questions" },
    },
    {
      stageKey: "research",
      request: (sources: ReturnType<typeof sourcesFor>) => ({
        _tag: "ResearchRequest",
        sources,
      }),
      result: { _tag: "Research", document: "# Research" },
    },
    {
      stageKey: "design",
      request: (sources: ReturnType<typeof sourcesFor>) => ({
        _tag: "DesignRequest",
        sources,
        designPolicy: { name: "qrspi.design-policy", version: 1 },
        promotionPolicy: { name: "qrspi.promotion-policy", version: 1 },
        structurePolicy: { name: "qrspi.structure-policy", version: 1 },
      }),
      result: { _tag: "Design", document: "# Design" },
    },
    {
      stageKey: "structure",
      request: (sources: ReturnType<typeof sourcesFor>) => ({
        _tag: "StructureRequest",
        sources,
        structurePolicy: { name: "qrspi.structure-policy", version: 1 },
        authority: structureAuthority,
      }),
      result: { _tag: "Structure", document: "# Structure" },
    },
    {
      stageKey: "plan",
      request: (sources: ReturnType<typeof sourcesFor>) => ({ _tag: "PlanRequest", sources }),
      result: { _tag: "Plan", document: "# Plan" },
    },
    {
      stageKey: "implementation",
      request: (sources: ReturnType<typeof sourcesFor>) => ({
        _tag: "ImplementationRequest",
        sources,
        checkpointPosition: 1,
        expectedParentSha: target.expectedParentSha,
      }),
      result: {
        _tag: "PreparedCommit",
        candidateCommitSha: "e".repeat(40),
        expectedParentSha: target.expectedParentSha,
        changedPaths: ["src/replay.ts"],
        final: false,
      },
    },
  ] as const

  for (const fixture of fixtures)
    test(`round trips ${fixture.stageKey} without mutable rediscovery`, async () => {
      const calls = { tracker: 0, repository: 0 }
      const contract = builtInStageContracts.find(
        ({ ref }) => ref.name === `qrspi.${fixture.stageKey}`,
      )!
      const scope = sourcesFor(fixture.stageKey)
      const request = fixture.request(scope)
      const persisted = JSON.parse(
        JSON.stringify(encodeStageProduceInput(scope, contract.ref, request)),
      )
      const before = new TrustedStageCatalog(builtInStageContracts).port()
      const after = new TrustedStageCatalog(builtInStageContracts).port()
      const firstTask = await Effect.runPromise(
        before.buildTask({
          input: persisted,
          ticketRevision: original,
          replayAuthority: replayAuthorityFor(contract, scope),
        }),
      )
      const replayedTask = await Effect.runPromise(
        after.buildTask({
          input: persisted,
          ticketRevision: original,
          replayAuthority: replayAuthorityFor(contract, scope),
        }),
      )
      expect(persisted.requestSha256).toBe(canonicalSha256(request))
      expect(replayedTask).toEqual(firstTask)
      expect(replayedTask.authority).toEqual({
        ticketRevision: scope.ticketRevision,
        sources: scope.sources,
        ...(fixture.stageKey === "structure" ? { structureAuthority } : {}),
      })
      const firstOutput = await Effect.runPromise(
        before.prepareOutput({
          contract: contract.ref,
          result: fixture.result,
          context: { scope, target },
        }),
      )
      expect(
        await Effect.runPromise(
          after.prepareOutput({
            contract: contract.ref,
            result: fixture.result,
            context: { scope, target },
          }),
        ),
      ).toEqual(firstOutput)
      expect(calls).toEqual({ tracker: 0, repository: 0 })
    })

  for (const fixture of fixtures)
    test(`rejects rehashed wrong-stage authority for ${fixture.stageKey}`, async () => {
      const contract = builtInStageContracts.find(
        ({ ref }) => ref.name === `qrspi.${fixture.stageKey}`,
      )!
      const wrongScope = sourcesFor("wrong-stage")
      const request = fixture.request(wrongScope)
      const input = encodeStageProduceInput(wrongScope, contract.ref, request)

      expect(
        await Effect.runPromise(
          new TrustedStageCatalog(builtInStageContracts)
            .port()
            .buildTask({
              input,
              ticketRevision: original,
              replayAuthority: replayAuthorityFor(contract, wrongScope),
            })
            .pipe(Effect.either),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })
    })

  test.each([
    ["generation", { generation: 2 }],
    ["run ordinal", { runOrdinal: 2 }],
    ["stage revision", { stageRevision: 2 }],
    ["workflow definition", { workflowDefinitionSha256: "f".repeat(64) }],
  ] as const)("rejects rehashed wrong-%s replay scope", async (_name, replacement) => {
    const contract = builtInStageContracts[0]
    const currentScope = sourcesFor("questions")
    const substitutedScope = { ...currentScope, ...replacement }
    const input = encodeStageProduceInput(substitutedScope, contract.ref, {
      _tag: "QuestionsRequest",
      sources: substitutedScope,
    })

    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(contract, currentScope),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })
  })

  test("rejects a predecessor pointer and snapshot relabeled with another built-in contract", async () => {
    const catalog = new TrustedStageCatalog(builtInStageContracts)
    const contract = builtInStageContracts.find(({ ref }) => ref.name === "qrspi.structure")!
    const scope = sourcesFor("structure")
    const source = scope.sources[0]!
    const { pointerSha256: _pointerSha256, ...pointerIdentity } = source.acceptedPointer
    const substitutedIdentity = {
      ...pointerIdentity,
      contract: researchStageContract.ref,
      contractRegistrationSha256: catalog.descriptor(researchStageContract.ref).registrationSha256,
    }
    const substitutedScope = {
      ...scope,
      sources: [
        {
          ...source,
          acceptedPointer: {
            ...substitutedIdentity,
            pointerSha256: canonicalSha256(substitutedIdentity),
          },
        },
      ],
    }
    const input = encodeStageProduceInput(substitutedScope, contract.ref, {
      _tag: "StructureRequest",
      sources: substitutedScope,
      structurePolicy: { name: "qrspi.structure-policy", version: 1 },
      authority: structureAuthority,
    })

    expect(
      await Effect.runPromise(
        catalog
          .port()
          .buildTask({
            input,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(contract, substitutedScope),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })
  })

  test("rejects unexpected durable request fields", async () => {
    const contract = builtInStageContracts[0]
    const scope = sourcesFor("questions")
    const input = encodeStageProduceInput(scope, contract.ref, {
      _tag: "QuestionsRequest",
      sources: scope,
      unexpected: "not in the contract",
    })

    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(contract, scope),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
  })

  test("rejects unexpected nested source fields", async () => {
    const contract = builtInStageContracts[0]
    const scope = sourcesFor("questions")
    const input = encodeStageProduceInput(scope, contract.ref, {
      _tag: "QuestionsRequest",
      sources: { ...scope, unexpected: "not in exact sources" },
    })

    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .buildTask({
            input,
            ticketRevision: original,
            replayAuthority: replayAuthorityFor(contract, scope),
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
  })

  test("rejects unexpected agent result fields", async () => {
    const contract = builtInStageContracts[0]
    const scope = sourcesFor("questions")

    expect(
      await Effect.runPromise(
        new TrustedStageCatalog(builtInStageContracts)
          .port()
          .prepareOutput({
            contract: contract.ref,
            result: {
              _tag: "Questions",
              document: "# Questions",
              unexpected: "not in the result contract",
            },
            context: { scope, target },
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_result" } })
  })
})
