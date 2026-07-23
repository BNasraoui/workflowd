import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentHarnessError, type AgentHarnessPort } from "../../src/agent-harness"
import {
  TrustedStageCatalog,
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

  test("rejects duplicate, unknown, and lookalike registrations with stable reasons", () => {
    expect(() => new TrustedStageCatalog([fixtureContract, fixtureContract])).toThrow(
      expect.objectContaining({ reason: "duplicate_reference" }),
    )
    const catalog = new TrustedStageCatalog([fixtureContract])
    expect(() =>
      catalog.descriptor({ name: "fixture.missing", contractVersion: 1 }),
    ).toThrow(expect.objectContaining({ reason: "unknown_reference" }))
    expect(() => catalog.registrationFor({ ...fixtureContract })).toThrow(
      expect.objectContaining({ reason: "untrusted_source" }),
    )
  })

  test("rejects malformed metadata, schemas, and durable envelope bounds", () => {
    for (const registration of [
      { ...fixtureContract, ref: { name: "", contractVersion: 1 } },
      { ...fixtureContract, requestSchema: "not-a-schema" },
      { ...fixtureContract, maxRequestBytes: 64 * 1024 + 1 },
      { ...fixtureContract, maxResultBytes: 4 * 1024 * 1024 + 1 },
    ]) {
      expect(() => new TrustedStageCatalog([registration as typeof fixtureContract])).toThrow(
        expect.objectContaining({ reason: "malformed_registration" }),
      )
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
