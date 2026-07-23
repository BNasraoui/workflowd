import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  AgentHarnessError,
  MAX_STAGE_REQUEST_BYTES,
  TrustedAgentHarnessCatalog,
  type AgentHarnessPort,
} from "../../src/agent-harness"
import { workflowDefinitionSha256 } from "../../src/qrspi/domain"
import {
  TrustedStageCatalog,
  questionsStageContract,
  validatePersistedSnapshots,
  validateWorkflowDefinition,
  type StageContract,
} from "../../src/qrspi/stage-catalog"

const FixtureRequest = Schema.Struct({ text: Schema.String.pipe(Schema.maxLength(100)) })
const FixtureResult = Schema.Struct({ summary: Schema.String.pipe(Schema.maxLength(100)) })
const ImplementationRequest = Schema.Struct({ baseSha: Schema.String.pipe(Schema.length(40)) })
const ImplementationResult = Schema.Struct({ commitSha: Schema.String.pipe(Schema.length(40)) })

const fixtureContract: StageContract<
  typeof FixtureRequest.Type,
  typeof FixtureRequest.Encoded,
  typeof FixtureResult.Type,
  typeof FixtureResult.Encoded
> = {
  ref: { name: "fixture.document", contractVersion: 1 },
  implementationRevision: "fixture.document.v1",
  kind: "document",
  requestSchema: FixtureRequest,
  resultSchema: FixtureResult,
  maxRequestBytes: 1_024,
  maxResultBytes: 1_024,
  compatibility: () => undefined,
  assembleRequest: () => ({ text: "fixture" }),
  buildTask: () => ({ title: "fixture", prompt: "fixture", resultSchema: FixtureResult }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.summary }),
}

const fixtureImplementationContract: StageContract<
  typeof ImplementationRequest.Type,
  typeof ImplementationRequest.Encoded,
  typeof ImplementationResult.Type,
  typeof ImplementationResult.Encoded
> = {
  ref: { name: "fixture.implementation", contractVersion: 1 },
  implementationRevision: "fixture.implementation.v1",
  kind: "implementation",
  requestSchema: ImplementationRequest,
  resultSchema: ImplementationResult,
  maxRequestBytes: 2_048,
  maxResultBytes: 2_048,
  compatibility: () => undefined,
  assembleRequest: () => ({ baseSha: "a".repeat(40) }),
  buildTask: () => ({
    title: "implement fixture",
    prompt: "implement fixture",
    resultSchema: ImplementationResult,
  }),
  prepareOutput: (result) => ({ _tag: "ImplementationStep", value: result }),
}

describe("TrustedStageCatalog", () => {
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

  test("extends the catalog with a second typed contract by registration alone", () => {
    const catalog = new TrustedStageCatalog([fixtureContract, fixtureImplementationContract])
    const registration = catalog.registrationFor(fixtureImplementationContract)
    const request = Schema.decodeUnknownSync(registration.requestSchema)({
      baseSha: "a".repeat(40),
    })
    const result = Schema.decodeUnknownSync(registration.resultSchema)({
      commitSha: "b".repeat(40),
    })

    expect(catalog.descriptor(fixtureContract.ref).kind).toBe("document")
    expect(registration.descriptor).toMatchObject({
      ref: fixtureImplementationContract.ref,
      kind: "implementation",
    })
    expect(registration.source.buildTask(request)).toMatchObject({
      title: "implement fixture",
      resultSchema: ImplementationResult,
    })
    expect(registration.source.prepareOutput(result, {})).toEqual({
      _tag: "ImplementationStep",
      value: { commitSha: "b".repeat(40) },
    })
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
