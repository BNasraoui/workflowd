import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  AgentHarnessError,
  MAX_STAGE_REQUEST_BYTES,
  TrustedAgentHarnessCatalog,
  type AgentHarnessPort,
} from "../../src/agent-harness"
import { makeOpenCodeHarnessDefinitions } from "../../src/opencode"
import {
  TicketRevision,
  canonicalSha256,
  ticketRevisionSha256For,
  workflowIdFor,
  workflowDefinitionSha256,
} from "../../src/qrspi/domain"
import {
  ExactStageSources,
  builtInStageContracts,
  designStageContract,
  encodeStageProduceInput,
  planStageContract,
  questionsStageContract,
  researchStageContract,
  structureStageContract,
} from "../../src/qrspi/contracts"
import {
  TrustedStageCatalog,
  validatePersistedSnapshots,
  validateWorkflowDefinition,
  type StageContract,
} from "../../src/qrspi/stage-catalog"

const FixtureRequest = Schema.Struct({ text: Schema.String.pipe(Schema.maxLength(100)) })
const FixtureResult = Schema.Struct({ summary: Schema.String.pipe(Schema.maxLength(100)) })

const fixtureContract: StageContract<
  typeof FixtureRequest.Type,
  typeof FixtureRequest.Encoded,
  typeof FixtureResult.Type,
  typeof FixtureResult.Encoded
> = {
  ref: { name: "fixture.document", contractVersion: 1 },
  stageKey: "fixture",
  implementationRevision: "fixture.document.v1",
  kind: "document",
  requestSchema: FixtureRequest,
  resultSchema: FixtureResult,
  maxRequestBytes: 1_024,
  maxResultBytes: 1_024,
  compatibility: () => undefined,
  assembleRequest: () => ({ text: "fixture" }),
  buildTask: () => ({
    title: "fixture",
    prompt: "fixture",
    authority: {
      ticketRevision: { workflowId: "fixture", ticketRevisionSha256: "a".repeat(64) },
      sources: [],
    },
    resultSchema: FixtureResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.summary }),
}

const invalidDocumentOutputContract: typeof fixtureContract = {
  ...fixtureContract,
  // @ts-expect-error Document contracts cannot prepare implementation output.
  prepareOutput: () => ({ _tag: "ImplementationStep", value: {} }),
}

// @ts-expect-error Implementation contracts cannot prepare document output.
const invalidImplementationOutputContract: StageContract<
  typeof FixtureRequest.Type,
  typeof FixtureRequest.Encoded,
  typeof FixtureResult.Type,
  typeof FixtureResult.Encoded
> = {
  ...fixtureContract,
  kind: "implementation",
  prepareOutput: () => ({ _tag: "Document", text: "wrong" }),
}

void invalidDocumentOutputContract
void invalidImplementationOutputContract

describe("TrustedStageCatalog", () => {
  test("registers the explicit six built-in contracts in stage order", () => {
    expect(builtInStageContracts.map(({ ref }) => ref)).toEqual([
      { name: "qrspi.questions", contractVersion: 1 },
      { name: "qrspi.research", contractVersion: 1 },
      { name: "qrspi.design", contractVersion: 1 },
      { name: "qrspi.structure", contractVersion: 1 },
      { name: "qrspi.plan", contractVersion: 1 },
      { name: "qrspi.implementation", contractVersion: 1 },
    ])
    const catalog = new TrustedStageCatalog(builtInStageContracts)
    expect(
      new Set(builtInStageContracts.map(({ ref }) => catalog.descriptor(ref).registrationSha256))
        .size,
    ).toBe(6)
  })
  test("erased execution invokes only the selected registration closures", async () => {
    const calls = {
      selected: { assemble: 0, build: 0, prepare: 0 },
      unselected: { assemble: 0, build: 0, prepare: 0 },
    }
    const Request = Schema.Struct({
      _tag: Schema.Literal("FixtureRequest"),
      sources: ExactStageSources,
    })
    const Result = Schema.Struct({ _tag: Schema.Literal("Fixture"), document: Schema.String })
    const makeContract = (name: "selected" | "unselected") => ({
      ref: { name: `fixture.${name}`, contractVersion: 1 },
      stageKey: "fixture",
      implementationRevision: `fixture.${name}.v1`,
      kind: "document" as const,
      requestSchema: Request,
      resultSchema: Result,
      maxRequestBytes: 8_192,
      maxResultBytes: 8_192,
      compatibility: () => undefined,
      assembleRequest: (exactSources: typeof ExactStageSources.Type) => {
        calls[name].assemble += 1
        return { _tag: "FixtureRequest" as const, sources: exactSources }
      },
      buildTask: (request: typeof Request.Type) => {
        calls[name].build += 1
        return {
          title: name,
          prompt: name,
          authority: {
            ticketRevision: request.sources.ticketRevision,
            sources: request.sources.sources,
          },
          resultSchema: Result,
        }
      },
      prepareOutput: (result: typeof Result.Type) => {
        calls[name].prepare += 1
        return { _tag: "Document" as const, text: result.document }
      },
    })
    const selected = makeContract("selected")
    const unselected = makeContract("unselected")
    const trustedCatalog = new TrustedStageCatalog([selected, unselected])
    const port = trustedCatalog.port()
    const readyTicket = {
      reference: {
        tracker: "beads" as const,
        trackerInstanceId: "workspace",
        nativeTicketId: "fixture",
      },
      issueType: "feature" as const,
      title: "Exercise selected closures",
      description: "Verify generic erased dispatch.",
      sources: ["https://example.test/source"],
      acceptanceCriteria: ["Only selected closures run."],
      scenarios: [
        {
          name: "Dispatch",
          given: "two registrations",
          when: "one is selected",
          then: "the other remains idle",
        },
      ],
    }
    const scenarioCoverage = [[0]]
    const ticketRevisionSha256 = ticketRevisionSha256For(readyTicket, scenarioCoverage)
    const repository = {
      providerInstanceId: "provider",
      repositoryId: "repository",
      repositoryFullName: "owner/repository",
    }
    const workflowId = workflowIdFor(repository, readyTicket.reference)
    const exactSources = {
      workflowId,
      generation: 1,
      stageKey: "fixture",
      runOrdinal: 1,
      stageRevision: 1,
      workflowDefinitionSha256: "b".repeat(64),
      stageDefinitionSha256: "c".repeat(64),
      ticketRevision: {
        workflowId,
        ticketRevisionSha256,
      },
      sources: [] as const,
      sourceSetSha256: canonicalSha256([]),
      target: {
        repository,
        headRef: "refs/heads/workflow",
        expectedParentSha: "e".repeat(40),
      },
    }
    const request = await Effect.runPromise(
      port.assembleRequest({
        contract: selected.ref,
        sources: exactSources,
        maxEncodedInputBytes: 8_192,
      }),
    )
    const input = encodeStageProduceInput(exactSources, selected.ref, request)
    const ticketRevision = Schema.decodeUnknownSync(TicketRevision)({
      readyTicket,
      scenarioCoverage,
      checkedAt: new Date("2026-07-24T00:00:00.000Z"),
      ticketRevisionSha256,
    })
    const replayAuthority = {
      target: exactSources.target,
      scope: {
        workflowId: exactSources.workflowId,
        generation: exactSources.generation,
        stageKey: exactSources.stageKey,
        runOrdinal: exactSources.runOrdinal,
        stageRevision: exactSources.stageRevision,
        workflowDefinitionSha256: exactSources.workflowDefinitionSha256,
        stageDefinitionSha256: exactSources.stageDefinitionSha256,
      },
      stageSnapshot: {
        stageKey: exactSources.stageKey,
        stageDefinitionSha256: exactSources.stageDefinitionSha256,
        contract: selected.ref,
        contractRegistrationSha256: trustedCatalog.descriptor(selected.ref).registrationSha256,
        maxEncodedInputBytes: 8_192,
      },
      predecessorSnapshots: [],
      acceptedPointers: [],
    }
    await Effect.runPromise(port.buildTask({ input, ticketRevision, replayAuthority }))
    await Effect.runPromise(
      port.prepareOutput({
        contract: selected.ref,
        result: { _tag: "Fixture", document: "selected" },
        context: { scope: exactSources, target: exactSources.target },
      }),
    )
    const malformedInput = encodeStageProduceInput(exactSources, selected.ref, {
      _tag: "OtherRequest",
      sources: exactSources,
    })
    expect(
      await Effect.runPromise(
        port
          .buildTask({ input: malformedInput, ticketRevision, replayAuthority })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_request" } })
    expect(
      await Effect.runPromise(
        port
          .prepareOutput({
            contract: selected.ref,
            result: { _tag: "OtherResult", document: "selected" },
            context: { scope: exactSources, target: exactSources.target },
          })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "malformed_result" } })

    expect(calls).toEqual({
      selected: { assemble: 1, build: 1, prepare: 1 },
      unselected: { assemble: 0, build: 0, prepare: 0 },
    })
  })
  test("returns a stable descriptor and restores the exact typed registration", () => {
    const first = new TrustedStageCatalog([fixtureContract])
    const second = new TrustedStageCatalog([fixtureContract])

    expect(first.descriptor(fixtureContract.ref)).toEqual(second.descriptor(fixtureContract.ref))
    expect(first.descriptor(fixtureContract.ref)).toMatchObject({
      ref: fixtureContract.ref,
      kind: "document",
      maxRequestBytes: 1_024,
      maxResultBytes: 1_024,
      registrationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const registration = first.registrationFor(fixtureContract)
    expect(registration.source).toBe(fixtureContract)
    expect(registration.requestSchema).toBe(FixtureRequest)
    expect(registration.resultSchema).toBe(FixtureResult)
    expect(Schema.decodeUnknownSync(registration.requestSchema)({ text: "typed" })).toEqual({
      text: "typed",
    })
  })

  test("includes the trusted executable implementation revision in registration identity", () => {
    const firstRegistration = {
      ...fixtureContract,
      implementationRevision: "fixture.document.v1",
    }
    const changedRegistration = {
      ...fixtureContract,
      implementationRevision: "fixture.document.v2",
    }

    const first = new TrustedStageCatalog([firstRegistration])
    const changed = new TrustedStageCatalog([changedRegistration])

    expect(first.descriptor(fixtureContract.ref).registrationSha256).not.toBe(
      changed.descriptor(fixtureContract.ref).registrationSha256,
    )
  })

  test("rejects duplicate, unknown, and lookalike registrations with stable reasons", () => {
    expect(() => new TrustedStageCatalog([fixtureContract, fixtureContract])).toThrow(
      expect.objectContaining({ reason: "duplicate_reference" }),
    )
    const catalog = new TrustedStageCatalog([fixtureContract])
    expect(() => catalog.descriptor({ name: "fixture.missing", contractVersion: 1 })).toThrow(
      expect.objectContaining({ reason: "unknown_reference" }),
    )
    expect(() => catalog.registrationFor({ ...fixtureContract })).toThrow(
      expect.objectContaining({ reason: "untrusted_source" }),
    )
  })

  test("rejects prepared output tags that contradict the trusted stage kind", async () => {
    const documentReturningImplementation = {
      ...fixtureContract,
      implementationRevision: "fixture.document.wrong-output.v1",
      prepareOutput: () => ({
        _tag: "ImplementationStep" as const,
        value: { commitSha: "a".repeat(40) },
      }),
    }
    const implementationReturningDocument = {
      ...fixtureContract,
      implementationRevision: "fixture.implementation.wrong-output.v1",
      kind: "implementation" as const,
      prepareOutput: () => ({ _tag: "Document" as const, text: "wrong kind" }),
    }
    const context = {
      scope: {
        workflowId: `wf_${"a".repeat(64)}`,
        generation: 1,
        stageKey: "fixture",
        runOrdinal: 1,
        stageRevision: 1,
        workflowDefinitionSha256: "b".repeat(64),
        stageDefinitionSha256: "c".repeat(64),
      },
      target: {
        repository: {
          providerInstanceId: "provider",
          repositoryId: "repository",
          repositoryFullName: "owner/repository",
        },
        headRef: "refs/heads/fixture",
        expectedParentSha: "d".repeat(40),
      },
    }

    for (const contract of [documentReturningImplementation, implementationReturningDocument]) {
      const result = await Effect.runPromise(
        new TrustedStageCatalog([contract])
          .port()
          .prepareOutput({
            contract: contract.ref,
            result: { summary: "fixture" },
            context,
          })
          .pipe(Effect.either),
      )
      expect(result).toMatchObject({
        _tag: "Left",
        left: { reason: "malformed_output" },
      })
    }
  })

  test("rejects malformed metadata, schemas, closures, and durable envelope bounds", () => {
    const { compatibility: _compatibility, ...withoutCompatibility } = fixtureContract
    for (const registration of [
      { ...fixtureContract, ref: { name: "", contractVersion: 1 } },
      { ...fixtureContract, requestSchema: "not-a-schema" },
      withoutCompatibility,
      { ...fixtureContract, assembleRequest: undefined },
      { ...fixtureContract, buildTask: undefined },
      { ...fixtureContract, prepareOutput: undefined },
      { ...fixtureContract, maxRequestBytes: MAX_STAGE_REQUEST_BYTES + 1 },
      { ...fixtureContract, maxResultBytes: 4 * 1024 * 1024 + 1 },
    ]) {
      expect(() => new TrustedStageCatalog([registration])).toThrow(
        expect.objectContaining({ reason: "malformed_registration" }),
      )
    }
  })

  test("keeps the built-in request bound within the nested launch envelope", () => {
    expect(questionsStageContract.maxRequestBytes).toBe(MAX_STAGE_REQUEST_BYTES)
  })

  test("reports malformed missing and non-object references as typed catalog errors", () => {
    for (const ref of [undefined, null, "not-a-reference"]) {
      expect(() => {
        Reflect.construct(TrustedStageCatalog, [[{ ...fixtureContract, ref }]])
      }).toThrow(expect.objectContaining({ reason: "malformed_registration" }))
    }
  })

  test("runs compatibility through the exact trusted source", async () => {
    const incompatible = {
      ...fixtureContract,
      compatibility: () => {
        throw new Error("unsupported output policy")
      },
    }
    const catalog = new TrustedStageCatalog([incompatible])
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
      validateAvailability: () => Effect.void,
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const definition = {
      contractVersion: 1,
      definitionVersion: 1,
      stages: [
        {
          key: "fixture",
          kind: "document",
          contract: incompatible.ref,
          activation: { mode: "enabled" },
          definitionVersion: 1,
          maxEncodedInputBytes: 1_024,
          producer: {
            harness: { name: "opencode", version: 1 },
            agent: "fixture-agent",
            model: "openai/gpt-5.6-sol",
            timeoutMs: 1_000,
            retry: { maxAttempts: 1, backoffMs: 1 },
          },
          outputPolicy: {
            _tag: "Artifact",
            pathTemplate: "docs/fixture.md",
            mediaType: "text/markdown",
          },
          reviewPolicy: { mode: "none" },
          humanGatePolicy: { mode: "none" },
        },
      ],
    } as const

    expect(
      await Effect.runPromise(
        validateWorkflowDefinition({
          definition,
          stageCatalog: catalog.port(),
          agentHarness: harness,
        }).pipe(Effect.either),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "WorkflowDefinitionValidationError",
        phase: "contract",
        reason: "incompatible_definition",
        stageKey: "fixture",
        sequencePosition: 1,
      },
    })
  })

  test("rejects unknown policy names as well as unsupported versions", async () => {
    const catalog = new TrustedStageCatalog([fixtureContract])
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
      validateAvailability: () => Effect.void,
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const stage = {
      key: "fixture",
      kind: "document" as const,
      contract: fixtureContract.ref,
      activation: {
        mode: "conditional" as const,
        policy: { name: "qrspi.activation", version: 1 },
        decision: "enabled" as const,
        reason: "fixture",
      },
      definitionVersion: 1,
      maxEncodedInputBytes: 1_024,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "fixture-agent",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 1_000,
        retry: { maxAttempts: 1, backoffMs: 1 },
      },
      outputPolicy: {
        _tag: "Artifact" as const,
        pathTemplate: "docs/fixture.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" as const },
      humanGatePolicy: { mode: "none" as const },
    }

    for (const policy of [
      { name: "unregistered-policy", version: 1 },
      { name: "qrspi.activation", version: 2 },
    ]) {
      const result = await Effect.runPromise(
        validateWorkflowDefinition({
          definition: {
            contractVersion: 1,
            definitionVersion: 1,
            stages: [{ ...stage, activation: { ...stage.activation, policy } }],
          },
          stageCatalog: catalog.port(),
          agentHarness: harness,
        }).pipe(Effect.either),
      )
      expect(result).toMatchObject({
        _tag: "Left",
        left: { phase: "contract", reason: "unsupported_policy", stageKey: "fixture" },
      })
    }
  })

  test("rejects a registered pull-request harness for stage execution", async () => {
    const catalog = new TrustedStageCatalog([fixtureContract])
    const definitions = makeOpenCodeHarnessDefinitions({
      reviewerAgent: "pr-reviewer",
      fixerAgent: "pr-fixer",
      model: "openai/gpt-5.6-sol",
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    })
    const harnessCatalog = new TrustedAgentHarnessCatalog(Object.values(definitions))
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed(harnessCatalog.describe(ref)),
      validateAvailability: () => Effect.void,
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }

    const result = await Effect.runPromise(
      validateWorkflowDefinition({
        definition: {
          contractVersion: 1,
          definitionVersion: 1,
          stages: [
            {
              key: "fixture",
              kind: "document",
              contract: fixtureContract.ref,
              activation: { mode: "enabled" },
              definitionVersion: 1,
              maxEncodedInputBytes: 1_024,
              producer: {
                harness: definitions.review.ref,
                agent: "pr-reviewer",
                model: "openai/gpt-5.6-sol",
                timeoutMs: 1_000,
                retry: { maxAttempts: 1, backoffMs: 1 },
              },
              outputPolicy: {
                _tag: "Artifact",
                pathTemplate: "docs/fixture.md",
                mediaType: "text/markdown",
              },
              reviewPolicy: { mode: "none" },
              humanGatePolicy: { mode: "none" },
            },
          ],
        },
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        phase: "harness",
        reason: "incompatible_definition",
        stageKey: "fixture",
        harnessRef: definitions.review.ref,
      },
    })
  })

  test("maps an availability failure to the exact selected stage", async () => {
    const catalog = new TrustedStageCatalog([fixtureContract])
    const failedSelection = {
      ref: { name: "opencode", version: 1 },
      agent: "second-agent",
      model: "openai/gpt-5.6-sol",
    } as const
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
      validateAvailability: () =>
        Effect.fail(
          Object.assign(
            new AgentHarnessError({
              operation: "validate OpenCode availability",
              cause: new Error("unavailable"),
              retryable: true,
            }),
            { selection: failedSelection },
          ),
        ),
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const stage = {
      key: "first",
      kind: "document" as const,
      contract: fixtureContract.ref,
      activation: { mode: "enabled" as const },
      definitionVersion: 1,
      maxEncodedInputBytes: 1_024,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "first-agent",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 1_000,
        retry: { maxAttempts: 1, backoffMs: 1 },
      },
      outputPolicy: {
        _tag: "Artifact" as const,
        pathTemplate: "docs/first.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" as const },
      humanGatePolicy: { mode: "none" as const },
    }
    const result = await Effect.runPromise(
      validateWorkflowDefinition({
        definition: {
          contractVersion: 1,
          definitionVersion: 1,
          stages: [
            stage,
            {
              ...stage,
              key: "second",
              producer: { ...stage.producer, agent: failedSelection.agent },
            },
          ],
        },
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "WorkflowDefinitionValidationError",
        phase: "availability",
        reason: "unavailable_agent_model",
        stageKey: "second",
        sequencePosition: 2,
        harnessRef: failedSelection.ref,
      },
    })
  })

  test.each([
    {
      reason: "unknown_harness_reference" as const,
      phase: "harness" as const,
      kind: "document" as const,
      harnessRef: { name: "missing-harness", version: 1 },
      outputPolicy: {
        _tag: "Artifact" as const,
        pathTemplate: "docs/diagnostic.md",
        mediaType: "text/markdown",
      },
    },
    {
      reason: "incompatible_kind" as const,
      phase: "contract" as const,
      kind: "implementation" as const,
      harnessRef: { name: "opencode", version: 1 },
      outputPolicy: {
        _tag: "ImplementationCheckpoint" as const,
        contractId: "fixture.checkpoint",
        contractVersion: 1,
      },
    },
    {
      reason: "incompatible_output" as const,
      phase: "contract" as const,
      kind: "document" as const,
      harnessRef: { name: "opencode", version: 1 },
      outputPolicy: {
        _tag: "ImplementationCheckpoint" as const,
        contractId: "fixture.checkpoint",
        contractVersion: 1,
      },
    },
  ])("reports complete typed fields for $reason", async (fixture) => {
    const catalog = new TrustedStageCatalog([fixtureContract])
    const harness: AgentHarnessPort = {
      describe: (ref) =>
        ref.name === "missing-harness"
          ? Effect.fail(
              new AgentHarnessError({
                operation: "describe harness",
                cause: new Error("unknown harness"),
                retryable: false,
              }),
            )
          : Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
      validateAvailability: () => Effect.void,
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const result = await Effect.runPromise(
      validateWorkflowDefinition({
        definition: {
          contractVersion: 1,
          definitionVersion: 1,
          stages: [
            {
              key: "diagnostic-stage",
              kind: fixture.kind,
              contract: fixtureContract.ref,
              activation: { mode: "enabled" },
              definitionVersion: 1,
              maxEncodedInputBytes: 1_024,
              producer: {
                harness: fixture.harnessRef,
                agent: "fixture-agent",
                model: "openai/gpt-5.6-sol",
                timeoutMs: 1_000,
                retry: { maxAttempts: 1, backoffMs: 1 },
              },
              outputPolicy: fixture.outputPolicy,
              reviewPolicy: { mode: "none" },
              humanGatePolicy: { mode: "none" },
            },
          ],
        },
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "WorkflowDefinitionValidationError",
        phase: fixture.phase,
        reason: fixture.reason,
        stageKey: "diagnostic-stage",
        sequencePosition: 1,
        contractRef: fixtureContract.ref,
        harnessRef: fixture.harnessRef,
      },
    })
  })
})

describe("persisted stage snapshots", () => {
  test("reruns contract compatibility before accepting persisted stages", async () => {
    const catalog = new TrustedStageCatalog([fixtureContract])
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
      validateAvailability: () => Effect.void,
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const definition = {
      contractVersion: 1,
      definitionVersion: 1,
      stages: [
        {
          key: "fixture",
          kind: "document",
          contract: fixtureContract.ref,
          activation: { mode: "enabled" },
          definitionVersion: 1,
          maxEncodedInputBytes: 1_024,
          producer: {
            harness: { name: "opencode", version: 1 },
            agent: "fixture-agent",
            model: "openai/gpt-5.6-sol",
            timeoutMs: 1_000,
            retry: { maxAttempts: 1, backoffMs: 1 },
          },
          outputPolicy: {
            _tag: "Artifact",
            pathTemplate: "docs/fixture.md",
            mediaType: "text/markdown",
          },
          reviewPolicy: { mode: "none" },
          humanGatePolicy: { mode: "none" },
        },
      ],
    } as const
    const validated = await Effect.runPromise(
      validateWorkflowDefinition({
        definition,
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }),
    )
    const incompatibleCatalog = new TrustedStageCatalog([
      {
        ...fixtureContract,
        compatibility: () => {
          throw new Error("persisted stage is no longer compatible")
        },
      },
    ])

    const result = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: incompatibleCatalog.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        phase: "contract",
        reason: "incompatible_definition",
        stageKey: "fixture",
        sequencePosition: 1,
      },
    })
  })

  test("validates descriptor identity and availability without executable contract calls", async () => {
    const catalog = new TrustedStageCatalog([fixtureContract])
    const selections: Array<unknown> = []
    const harnessDefinition = {
      ref: { name: "opencode", version: 1 },
      implementationRevision: "opencode.v1",
      agent: "fixture-agent",
      model: "openai/gpt-5.6-sol",
      inputSchema: Schema.Unknown,
      outputSchema: Schema.Unknown,
      maxInputBytes: 1_024,
      maxOutputBytes: 1_024,
      promptContract: "fixture-stage",
      title: () => "fixture",
      prompt: () => "fixture",
      timeoutMs: 1_000,
      retryPolicy: {
        maxAttempts: 1,
        structuredOutputRetryCount: 0,
        invalidOutput: "fail" as const,
      },
    }
    const harnessCatalog = new TrustedAgentHarnessCatalog([harnessDefinition])
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed(harnessCatalog.describe(ref)),
      validateAvailability: (input) => {
        selections.push(...input.selections)
        return Effect.void
      },
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const definition = {
      contractVersion: 1,
      definitionVersion: 1,
      stages: [
        {
          key: "fixture",
          kind: "document",
          contract: fixtureContract.ref,
          activation: { mode: "enabled" },
          definitionVersion: 1,
          maxEncodedInputBytes: 1_024,
          producer: {
            harness: { name: "opencode", version: 1 },
            agent: "fixture-agent",
            model: "openai/gpt-5.6-sol",
            timeoutMs: 1_000,
            retry: { maxAttempts: 1, backoffMs: 1 },
          },
          outputPolicy: {
            _tag: "Artifact",
            pathTemplate: "docs/fixture.md",
            mediaType: "text/markdown",
          },
          reviewPolicy: { mode: "none" },
          humanGatePolicy: { mode: "none" },
        },
      ],
    } as const
    const validated = await Effect.runPromise(
      validateWorkflowDefinition({
        definition,
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }),
    )
    selections.length = 0
    await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }),
    )
    expect(selections).toEqual([
      {
        ref: { name: "opencode", version: 1 },
        agent: "fixture-agent",
        model: "openai/gpt-5.6-sol",
      },
    ])

    const unavailable = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: catalog.port(),
        agentHarness: {
          ...harness,
          validateAvailability: ({ selections }) => {
            const selection = selections[0]!
            return Effect.fail(
              new AgentHarnessError({
                operation: "validate OpenCode availability",
                cause: new Error("unavailable"),
                retryable: true,
                selection,
              }),
            )
          },
        },
      }).pipe(Effect.either),
    )
    expect(unavailable).toMatchObject({
      _tag: "Left",
      left: {
        phase: "availability",
        reason: "unavailable_agent_model",
        stageKey: "fixture",
        sequencePosition: 1,
        contractRef: fixtureContract.ref,
        harnessRef: { name: "opencode", version: 1 },
      },
    })

    const changed = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: [
          {
            ...validated.stageSnapshots[0]!,
            contractRegistrationSha256: "c".repeat(64),
          },
        ],
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )
    expect(changed).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "WorkflowDefinitionValidationError",
        phase: "contract",
        reason: "registration_hash_mismatch",
        expectedRegistrationSha256: "c".repeat(64),
        actualRegistrationSha256: catalog.descriptor(fixtureContract.ref).registrationSha256,
      },
    })

    const changedImplementation = new TrustedStageCatalog([
      { ...fixtureContract, implementationRevision: "fixture.document.v2" },
    ])
    const changedImplementationResult = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: changedImplementation.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )
    expect(changedImplementationResult).toMatchObject({
      _tag: "Left",
      left: {
        phase: "contract",
        reason: "registration_hash_mismatch",
        expectedRegistrationSha256: catalog.descriptor(fixtureContract.ref).registrationSha256,
        actualRegistrationSha256: changedImplementation.descriptor(fixtureContract.ref)
          .registrationSha256,
      },
    })

    const missingContract = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: new TrustedStageCatalog([]).port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )
    expect(missingContract).toMatchObject({
      _tag: "Left",
      left: {
        reason: "unknown_contract_reference",
        stageKey: "fixture",
        sequencePosition: 1,
      },
    })

    const missingHarness = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: catalog.port(),
        agentHarness: {
          ...harness,
          describe: () =>
            Effect.fail(
              new AgentHarnessError({
                operation: "describe harness",
                cause: new Error("missing harness"),
                retryable: false,
              }),
            ),
        },
      }).pipe(Effect.either),
    )
    expect(missingHarness).toMatchObject({
      _tag: "Left",
      left: {
        reason: "unknown_harness_reference",
        stageKey: "fixture",
        sequencePosition: 1,
      },
    })

    const changedHarness = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: [
          {
            ...validated.stageSnapshots[0]!,
            harnessRegistrationSha256: "d".repeat(64),
          },
        ],
        stageCatalog: catalog.port(),
        agentHarness: harness,
      }).pipe(Effect.either),
    )
    expect(changedHarness).toMatchObject({
      _tag: "Left",
      left: {
        phase: "harness",
        reason: "registration_hash_mismatch",
        expectedRegistrationSha256: "d".repeat(64),
        actualRegistrationSha256: harnessCatalog.describe(harnessDefinition.ref).registrationSha256,
      },
    })

    const changedHarnessCatalog = new TrustedAgentHarnessCatalog([
      { ...harnessDefinition, implementationRevision: "opencode.v2" },
    ])
    const changedHarnessImplementation = await Effect.runPromise(
      validatePersistedSnapshots({
        workflowDefinitionSha256: workflowDefinitionSha256(definition),
        snapshots: validated.stageSnapshots,
        stageCatalog: catalog.port(),
        agentHarness: {
          ...harness,
          describe: (ref) => Effect.succeed(changedHarnessCatalog.describe(ref)),
        },
      }).pipe(Effect.either),
    )
    expect(changedHarnessImplementation).toMatchObject({
      _tag: "Left",
      left: {
        phase: "harness",
        reason: "registration_hash_mismatch",
        expectedRegistrationSha256: harnessCatalog.describe(harnessDefinition.ref)
          .registrationSha256,
        actualRegistrationSha256: changedHarnessCatalog.describe(harnessDefinition.ref)
          .registrationSha256,
      },
    })
  })
})

describe("Questions and Research contract compatibility", () => {
  const definitionFor = (stageKey: "questions" | "research") => ({
    key: stageKey,
    kind: "document" as const,
    contract: { name: `qrspi.${stageKey}`, contractVersion: 1 },
    activation: { mode: "enabled" as const },
    definitionVersion: 1,
    maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
    producer: {
      harness: { name: "opencode", version: 1 },
      agent: `${stageKey}-agent`,
      model: "openai/gpt-5.6-sol",
      timeoutMs: 1_000,
      retry: { maxAttempts: 1, backoffMs: 1 },
    },
    outputPolicy: {
      _tag: "Artifact" as const,
      pathTemplate: `artifacts/${stageKey}.md`,
      mediaType: "text/markdown",
    },
    reviewPolicy: { mode: "none" as const },
    humanGatePolicy: { mode: "none" as const },
  })

  test.each([
    [questionsStageContract, "questions"],
    [researchStageContract, "research"],
  ] as const)("rejects non-Markdown and specialized %s definitions", async (contract, stageKey) => {
    const catalog = new TrustedStageCatalog([contract]).port()
    const definition = definitionFor(stageKey)
    for (const change of [
      { outputPolicy: { ...definition.outputPolicy, mediaType: "application/json" } },
      { designPolicy: { name: "qrspi.design-policy", version: 1 } },
    ]) {
      expect(
        await Effect.runPromise(
          catalog.validateCompatibility({ ...definition, ...change }).pipe(Effect.either),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "incompatible_definition" } })
    }
  })

  test.each([
    [questionsStageContract, "questions"],
    [researchStageContract, "research"],
  ] as const)(
    "reapplies %s media compatibility to persisted snapshots",
    async (contract, stageKey) => {
      const catalog = new TrustedStageCatalog([contract])
      const definition = {
        ...definitionFor(stageKey),
        outputPolicy: {
          ...definitionFor(stageKey).outputPolicy,
          mediaType: "application/json",
        },
      }
      const harness: AgentHarnessPort = {
        describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
        validateAvailability: () => Effect.void,
        prepare: () => Effect.die("unused"),
        createSession: () => Effect.die("unused"),
        resumeSession: () => Effect.die("unused"),
        abortSession: () => Effect.die("unused"),
      }
      const snapshot = {
        sequencePosition: 1,
        stageDefinitionSha256: canonicalSha256({
          contractVersion: 1,
          normalizationVersion: "RFC8785-NFC-1",
          definition,
        }),
        definition,
        contractRegistrationSha256: catalog.descriptor(contract.ref).registrationSha256,
        harnessRegistrationSha256: "b".repeat(64),
      }

      expect(
        await Effect.runPromise(
          validatePersistedSnapshots({
            workflowDefinitionSha256: "a".repeat(64),
            snapshots: [snapshot],
            stageCatalog: catalog.port(),
            agentHarness: harness,
          }).pipe(Effect.either),
        ),
      ).toMatchObject({
        _tag: "Left",
        left: { phase: "contract", reason: "incompatible_definition", stageKey },
      })
    },
  )
})

describe("Design contract compatibility", () => {
  const designDefinition = {
    key: "design",
    kind: "document" as const,
    contract: { name: "qrspi.design", contractVersion: 1 },
    activation: { mode: "enabled" as const },
    definitionVersion: 1,
    maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
    producer: {
      harness: { name: "opencode", version: 1 },
      agent: "design-agent",
      model: "openai/gpt-5.6-sol",
      timeoutMs: 1_000,
      retry: { maxAttempts: 1, backoffMs: 1 },
    },
    outputPolicy: {
      _tag: "Artifact" as const,
      pathTemplate: "artifacts/design.md",
      mediaType: "text/markdown",
    },
    reviewPolicy: { mode: "none" as const },
    humanGatePolicy: { mode: "none" as const },
    designPolicy: { name: "qrspi.design-policy", version: 1 },
    promotionPolicy: { name: "qrspi.promotion-policy", version: 1 },
  }

  test.each([
    ["missing Design policy", { designPolicy: undefined }],
    ["changed Design policy", { designPolicy: { name: "qrspi.other", version: 1 } }],
    ["missing promotion policy", { promotionPolicy: undefined }],
    ["changed promotion policy", { promotionPolicy: { name: "qrspi.other", version: 1 } }],
    [
      "wrong media type",
      { outputPolicy: { ...designDefinition.outputPolicy, mediaType: "text/plain" } },
    ],
  ])("rejects %s in fresh compatibility", async (_name, change) => {
    const result = await Effect.runPromise(
      new TrustedStageCatalog([designStageContract])
        .port()
        .validateCompatibility({ ...designDefinition, ...change })
        .pipe(Effect.either),
    )
    expect(result).toMatchObject({ _tag: "Left", left: { reason: "incompatible_definition" } })
  })

  test("reapplies Design compatibility to persisted snapshots", async () => {
    const catalog = new TrustedStageCatalog([designStageContract])
    const harness: AgentHarnessPort = {
      describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
      validateAvailability: () => Effect.void,
      prepare: () => Effect.die("unused"),
      createSession: () => Effect.die("unused"),
      resumeSession: () => Effect.die("unused"),
      abortSession: () => Effect.die("unused"),
    }
    const snapshot = {
      sequencePosition: 1,
      stageDefinitionSha256: canonicalSha256({
        contractVersion: 1,
        normalizationVersion: "RFC8785-NFC-1",
        definition: designDefinition,
      }),
      definition: designDefinition,
      contractRegistrationSha256: catalog.descriptor(designStageContract.ref).registrationSha256,
      harnessRegistrationSha256: "b".repeat(64),
    }
    const { promotionPolicy: _promotionPolicy, ...missingPromotionPolicy } = designDefinition
    const incompatible = {
      ...snapshot,
      definition: missingPromotionPolicy,
    }
    incompatible.stageDefinitionSha256 = canonicalSha256({
      contractVersion: 1,
      normalizationVersion: "RFC8785-NFC-1",
      definition: incompatible.definition,
    })

    expect(
      await Effect.runPromise(
        validatePersistedSnapshots({
          workflowDefinitionSha256: "a".repeat(64),
          snapshots: [incompatible],
          stageCatalog: catalog.port(),
          agentHarness: harness,
        }).pipe(Effect.either),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: { phase: "contract", reason: "incompatible_definition", stageKey: "design" },
    })
  })
})

describe("Structure contract compatibility", () => {
  const definition = {
    key: "structure",
    kind: "document" as const,
    contract: { name: "qrspi.structure", contractVersion: 1 },
    activation: { mode: "enabled" as const },
    definitionVersion: 1,
    maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
    producer: {
      harness: { name: "opencode", version: 1 },
      agent: "structure-agent",
      model: "openai/gpt-5.6-sol",
      timeoutMs: 1_000,
      retry: { maxAttempts: 1, backoffMs: 1 },
    },
    outputPolicy: {
      _tag: "Artifact" as const,
      pathTemplate: "artifacts/structure.md",
      mediaType: "text/markdown",
    },
    reviewPolicy: { mode: "none" as const },
    humanGatePolicy: { mode: "none" as const },
    structurePolicy: { name: "qrspi.structure-policy", version: 1 },
  }

  test.each([
    ["missing Structure policy", { structurePolicy: undefined }],
    ["changed Structure policy", { structurePolicy: { name: "qrspi.other", version: 1 } }],
    ["wrong output", { outputPolicy: { ...definition.outputPolicy, mediaType: "text/plain" } }],
  ])("rejects %s", async (_name, change) => {
    expect(
      await Effect.runPromise(
        new TrustedStageCatalog([structureStageContract])
          .port()
          .validateCompatibility({ ...definition, ...change })
          .pipe(Effect.either),
      ),
    ).toMatchObject({ _tag: "Left", left: { reason: "incompatible_definition" } })
  })
})

describe("Plan erased dispatch", () => {
  test("invokes only the selected Plan closures", async () => {
    const calls = { plan: 0, other: 0 }
    const selected = {
      ...planStageContract,
      implementationRevision: "qrspi.plan.closure-test.v1",
      assembleRequest: (...args: Parameters<typeof planStageContract.assembleRequest>) => {
        calls.plan += 1
        return planStageContract.assembleRequest(...args)
      },
    }
    const unselected = {
      ...questionsStageContract,
      implementationRevision: "qrspi.questions.closure-test.v1",
      assembleRequest: (...args: Parameters<typeof questionsStageContract.assembleRequest>) => {
        calls.other += 1
        return questionsStageContract.assembleRequest(...args)
      },
    }
    const exactSources = {
      workflowId: `wf_${"a".repeat(64)}`,
      generation: 1,
      stageKey: "plan",
      runOrdinal: 1,
      stageRevision: 1,
      workflowDefinitionSha256: "b".repeat(64),
      stageDefinitionSha256: "c".repeat(64),
      ticketRevision: {
        workflowId: `wf_${"a".repeat(64)}`,
        ticketRevisionSha256: "d".repeat(64),
      },
      sources: [] as const,
      sourceSetSha256: canonicalSha256([]),
      target: {
        repository: {
          providerInstanceId: "provider",
          repositoryId: "repository",
          repositoryFullName: "owner/repository",
        },
        headRef: "workflow/plan",
        expectedParentSha: "e".repeat(40),
      },
    }

    await Effect.runPromise(
      new TrustedStageCatalog([unselected, selected]).port().assembleRequest({
        contract: selected.ref,
        sources: exactSources,
        maxEncodedInputBytes: MAX_STAGE_REQUEST_BYTES,
      }),
    )
    expect(calls).toEqual({ plan: 1, other: 0 })
  })
})
