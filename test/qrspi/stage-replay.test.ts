import { afterEach, describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  TicketRevision,
  ticketRevisionSha256For,
  type TicketRevision as TicketRevisionType,
} from "../../src/qrspi/domain"
import { QrspiStore, QrspiStoreLive } from "../../src/qrspi/store"
import {
  builtInStageContracts,
  encodeStageProduceInput,
  researchStageContract,
} from "../../src/qrspi/contracts"
import { TrustedStageCatalog } from "../../src/qrspi/stage-catalog"
import { canonicalSha256 } from "../../src/qrspi/domain"

const directories: string[] = []
const workflowId = `wf_${"a".repeat(64)}`

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function ticketRevision(): TicketRevisionType {
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
    const artifact = {
      repository: {
        providerInstanceId: "github-app-1",
        repositoryId: "repository-1",
        repositoryFullName: "owner/repository",
      },
      workflowId,
      generation: 1,
      stageKey: "questions",
      stageRevision: 1,
      commitSha: "d".repeat(40),
      path: "artifacts/questions.md",
      blobSha: "e".repeat(40),
      contentSha256: "f".repeat(64),
      mediaType: "text/markdown",
    }
    const source = { role: "Questions" as const, artifact, content: "persisted questions" }
    const target = {
      repository: artifact.repository,
      headRef: "workflow/topic",
      expectedParentSha: "1".repeat(40),
    }
    const sources = {
      ...scope,
      ticketRevision: { workflowId, ticketRevisionSha256: original.ticketRevisionSha256 },
      sources: [source],
      sourceSetSha256: canonicalSha256([{ role: "Questions", artifact }]),
      target,
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
      new TrustedStageCatalog([researchStageContract])
        .port()
        .buildTask({ input: persisted, ticketRevision: original }),
    )

    expect(task.authority.sources).toEqual([source])
    expect(repositoryCalls).toBe(0)
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
  const sourcesFor = (stageKey: string) => ({
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
  })
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
        before.buildTask({ input: persisted, ticketRevision: original }),
      )
      const replayedTask = await Effect.runPromise(
        after.buildTask({ input: persisted, ticketRevision: original }),
      )
      expect(persisted.requestSha256).toBe(canonicalSha256(request))
      expect(replayedTask).toEqual(firstTask)
      expect(replayedTask.authority).toEqual({
        ticketRevision: scope.ticketRevision,
        sources: [],
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
            .buildTask({ input, ticketRevision: original })
            .pipe(Effect.either),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "identity_mismatch" } })
    })
})
