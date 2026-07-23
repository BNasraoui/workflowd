import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  Ticket,
  canonicalSha256,
  checkTicket as checkTicketDomain,
  normalizeWorkflowDefinition,
  workflowIdFor,
} from "../../src/qrspi/domain"
import { makeWorkspaceSourceResolver } from "../../src/qrspi/source-resolver"

const reference = {
  tracker: "beads",
  trackerInstanceId: "workspace-42",
  nativeTicketId: "workflowd-vs3.3",
} as const
const optionalStory = {
  userStory: "optional",
  productDirection: "consistent",
  productOutcome: "clear",
  acceptanceCriteriaObservability: ["observable"],
  scenarioCoverage: [[0]],
} as const
const contradictoryDirection = {
  ...optionalStory,
  productDirection: "contradictory",
} as const

function checkTicket(
  ticket: Parameters<typeof checkTicketDomain>[0],
  checkedAt: Parameters<typeof checkTicketDomain>[1],
  judgment: Parameters<typeof checkTicketDomain>[2],
) {
  return checkTicketDomain(ticket, checkedAt, judgment, () => true)
}

describe("QRSPI ticket boundary", () => {
  test("decodes an incomplete ticket and reports product problems without technical requirements", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)({
      reference,
      issueType: "feature",
      title: "Kick off QRSPI",
    })

    const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), {
      userStory: "required",
      productDirection: "consistent",
      productOutcome: "clear",
      acceptanceCriteriaObservability: [],
      scenarioCoverage: [],
    })

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map((problem) => problem.code)).toEqual([
        "missing_description",
        "missing_user_story",
        "missing_acceptance_criteria",
        "missing_scenarios",
        "unresolved_source",
      ])
      expect(result.problems.every((problem) => problem.message.length > 0)).toBe(true)
    }
  })

  test("rejects malformed bounded ticket fields before readiness", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(Ticket)({
        reference,
        issueType: "feature",
        title: "x".repeat(501),
      }).pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
  })

  test("decodes a partially written scenario and reports it as a readiness problem", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)({
      reference,
      issueType: "feature",
      title: "Kick off a QRSPI workflow",
      description:
        "Workflowd needs an authorized kickoff path that preserves product authority while creating durable work for repository maintainers.",
      userStory:
        "As a repository maintainer, I want durable kickoff, so that planning survives restarts.",
      sources: ["https://example.test/contract"],
      acceptanceCriteria: ["A running generation is created."],
      scenarios: [{ name: "Incomplete scenario" }],
    })

    const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map((item) => item.code)).toContain("invalid_scenario")
    }
  })

  test("allows a feature without a story when the readiness judgment makes it optional", () => {
    const { userStory: _, ...withoutStory } = readyTicket()
    const ticket = Schema.decodeUnknownSync(Ticket)(withoutStory)

    expect(checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)._tag).toBe(
      "Ready",
    )
  })

  test("accepts explicit coverage when one scenario covers multiple criteria", () => {
    const base = readyTicket()
    const ticket = Schema.decodeUnknownSync(Ticket)({
      ...base,
      acceptanceCriteria: [
        "An authorized caller receives a durable running generation.",
        "The generation remains recoverable after a restart.",
      ],
      scenarios: [
        {
          name: "Durable kickoff",
          given: "a ready ticket and unchanged repository",
          when: "the caller starts QRSPI and the service restarts",
          then: "the same durable generation remains running",
        },
      ],
    })

    const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), {
      ...optionalStory,
      acceptanceCriteriaObservability: ["observable", "observable"],
      scenarioCoverage: [[0], [0]],
    })

    expect(result._tag).toBe("Ready")
    if (result._tag === "Ready") {
      expect(result.ticketRevision.scenarioCoverage).toEqual([[0], [0]])
    }
  })

  test("reports a trusted unresolved product contradiction", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)(readyTicket())

    const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), contradictoryDirection)

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map(({ code }) => code)).toContain("contradictory_product_direction")
    }
  })

  test("allows a story for non-feature work when the readiness judgment makes it appropriate", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)({
      ...readyTicket(),
      issueType: "task",
    })

    expect(checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)._tag).toBe(
      "Ready",
    )
  })

  test("excludes tracker observation metadata from the ticket revision hash", () => {
    const decode = Schema.decodeUnknownSync(Ticket)
    const first = checkTicket(
      decode({
        reference,
        issueType: "feature",
        title: "Kick off a QRSPI workflow",
        description: "Product context.",
        userStory: "As a maintainer, I want kickoff, so that work is durable.",
        sources: ["https://example.test/contract"],
        acceptanceCriteria: ["A generation exists."],
        scenarios: [{ name: "Start", given: "ready", when: "started", then: "it exists" }],
        sourceRevision: "tracker-revision-1",
      }),
      new Date("2026-07-21T05:00:00.000Z"),
      optionalStory,
    )
    expect(first._tag).toBe("Ready")
    if (first._tag === "Ready") {
      const second = checkTicket(
        decode({
          ...first.readyTicket,
          sourceRevision: "tracker-revision-2",
        }),
        new Date("2026-07-22T05:00:00.000Z"),
        optionalStory,
      )
      expect(second._tag).toBe("Ready")
      if (second._tag !== "Ready") throw new Error("Expected ready ticket")
      expect(second.ticketRevision.ticketRevisionSha256).toBe(
        first.ticketRevision.ticketRevisionSha256,
      )
    }
  })

  test("uses RFC 8785 UTF-16 property ordering after NFC normalization", () => {
    const value = { "€": "euro", "\r": "cr", "😀": "grin", ö: "o", "1": "one", "": "ctl" }
    const canonical = '{"\\r":"cr","1":"one","":"ctl","ö":"o","€":"euro","😀":"grin"}'

    expect(canonicalSha256(value)).toBe(createHash("sha256").update(canonical).digest("hex"))
    expect(canonicalSha256({ value: "e\u0301" })).toBe(canonicalSha256({ value: "é" }))
  })

  test("rejects keys that collide after NFC normalization", () => {
    expect(() => canonicalSha256({ "e\u0301": 1, é: 2 })).toThrow("normalization collision")
  })

  test("rejects values outside the RFC 8785 JSON domain", () => {
    expect(() => canonicalSha256({ missing: undefined })).toThrow("not valid JSON")
    expect(() => canonicalSha256(-0)).toThrow("negative zero")
  })

  test.each(["\ud800", "\udc00"])("rejects the lone surrogate %p", (surrogate) => {
    expect(() => canonicalSha256({ value: surrogate })).toThrow("lone surrogate")
    expect(() => canonicalSha256({ [surrogate]: "value" })).toThrow("lone surrogate")
  })

  test("uses an unambiguous bounded workflow identity", () => {
    const left = workflowIdFor(
      { providerInstanceId: "provider:a", repositoryId: "b", repositoryFullName: "o/r" },
      reference,
    )
    const right = workflowIdFor(
      { providerInstanceId: "provider", repositoryId: "a:b", repositoryFullName: "o/r" },
      reference,
    )

    expect(left).not.toBe(right)
    expect(left).toMatch(/^wf_[0-9a-f]{64}$/)
    expect(left.length).toBeLessThanOrEqual(256)
  })

  test("uses trusted semantic readiness judgments without retaining them in the Beads ticket", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)({
      reference,
      issueType: "feature",
      title: "Start workflow",
      description: "Context",
      userStory: "As a maintainer, I want kickoff, so that work survives.",
      sources: ["https://example.test/contract"],
      acceptanceCriteria: ["It starts."],
      scenarios: [{ name: "Start", given: "ready", when: "started", then: "running" }],
      readinessEvidence: { contradiction: "untrusted extra field" },
    })

    expect(ticket).not.toHaveProperty("readinessEvidence")
    const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), {
      ...optionalStory,
      productOutcome: "unclear",
      acceptanceCriteriaObservability: ["unobservable"],
    })

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map(({ code }) => code)).toEqual([
        "unclear_product_outcome",
        "unobservable_acceptance_criterion",
      ])
    }
  })

  test("rejects source text that has no locally resolvable URL, file, or reference syntax", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)({
      reference,
      issueType: "feature",
      title: "Start workflow",
      description: "Context",
      userStory: "As a maintainer, I want kickoff, so that work survives.",
      sources: ["somewhere useful"],
      acceptanceCriteria: ["It starts."],
      scenarios: [{ name: "Start", given: "ready", when: "started", then: "running" }],
    })
    const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map(({ code }) => code)).toContain("unresolved_source")
    }
  })

  test("rejects a well-formed repository path that the trusted resolver cannot resolve", () => {
    const ticket = Schema.decodeUnknownSync(Ticket)({
      ...readyTicket(),
      sources: ["docs/does-not-exist.md"],
    })
    const result = checkTicketDomain(
      ticket,
      new Date("2026-07-21T05:00:00.000Z"),
      optionalStory,
      makeWorkspaceSourceResolver(process.cwd()),
    )

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map(({ code }) => code)).toContain("unresolved_source")
    }
  })

  test("accepts supported non-file references through the workspace resolver", () => {
    const resolveSource = makeWorkspaceSourceResolver(process.cwd())

    expect(resolveSource("https://example.test/contracts/qrspi")).toBe(true)
    expect(resolveSource("http://example.test/contracts/qrspi")).toBe(true)
    expect(resolveSource("beads:workflowd-vs3.3")).toBe(true)
    expect(resolveSource("ticket:workflowd-vs3.3")).toBe(true)
    expect(resolveSource("provenance:requirement-42")).toBe(true)
    expect(resolveSource("https://")).toBe(false)
    expect(resolveSource("beads:")).toBe(false)
  })

  test("reports structural placeholder acceptance criteria as unobservable", () => {
    for (const criterion of ["TODO", "TBD", "unknown", "  todo: decide later  "]) {
      const ticket = Schema.decodeUnknownSync(Ticket)({
        reference,
        issueType: "feature",
        title: "Start workflow",
        description: "Context",
        userStory: "As a maintainer, I want kickoff, so that work survives.",
        sources: ["docs/qrspi-contract.md"],
        acceptanceCriteria: [criterion],
        scenarios: [{ name: "Start", given: "ready", when: "started", then: "running" }],
      })

      const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)

      expect(result._tag).toBe("NeedsWork")
      if (result._tag === "NeedsWork") {
        expect(result.problems.map(({ code }) => code)).toContain(
          "unobservable_acceptance_criterion",
        )
      }
    }
  })

  test("rejects deterministic low-information product fields", () => {
    const cases = [
      ["title", "x", "unclear_title"],
      ["title", "???", "unclear_title"],
      ["title", "TBD", "unclear_title"],
      ["description", "x", "unclear_product_outcome"],
      ["description", "...", "unclear_product_outcome"],
      ["description", "placeholder", "unclear_product_outcome"],
    ] as const

    for (const [field, value, expectedCode] of cases) {
      const ticket = Schema.decodeUnknownSync(Ticket)({ ...readyTicket(), [field]: value })
      const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)

      expect(result._tag).toBe("NeedsWork")
      if (result._tag === "NeedsWork") {
        expect(result.problems.map(({ code }) => code)).toContain(expectedCode)
      }
    }
  })

  test("rejects low-information criteria and scenario fields", () => {
    for (const criterion of ["x", "!!!", "N/A"]) {
      const ticket = Schema.decodeUnknownSync(Ticket)({
        ...readyTicket(),
        acceptanceCriteria: [criterion],
      })
      const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)
      expect(result._tag).toBe("NeedsWork")
      if (result._tag === "NeedsWork") {
        expect(result.problems.map(({ code }) => code)).toContain(
          "unobservable_acceptance_criterion",
        )
      }
    }

    for (const [field, value] of [
      ["name", "x"],
      ["given", "?"],
      ["when", "TODO"],
      ["then", "unknown"],
    ] as const) {
      const base = readyTicket()
      const ticket = Schema.decodeUnknownSync(Ticket)({
        ...base,
        scenarios: [{ ...base.scenarios[0], [field]: value }],
      })
      const result = checkTicket(ticket, new Date("2026-07-21T05:00:00.000Z"), optionalStory)
      expect(result._tag).toBe("NeedsWork")
      if (result._tag === "NeedsWork") {
        expect(result.problems.map(({ code }) => code)).toContain("invalid_scenario")
      }
    }
  })

  test("normalizes and hashes the complete trusted stage semantics", () => {
    const definition = {
      contractVersion: 1,
      definitionVersion: 3,
      stages: [
        {
          key: "questions",
          kind: "document",
          contract: { name: "qrspi.questions", contractVersion: 1 },
          activation: { mode: "enabled" },
          definitionVersion: 2,
          maxEncodedInputBytes: 16_384,
          producer: {
            harness: { name: "opencode", version: 1 },
            agent: "qrspi-questions",
            model: "openai/gpt-5.6-sol",
            timeoutMs: 60_000,
            retry: { maxAttempts: 3, backoffMs: 1_000 },
          },
          outputPolicy: {
            _tag: "Artifact",
            pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
            mediaType: "text/markdown",
          },
          reviewPolicy: {
            mode: "automated",
            minimumContributions: 1,
            maximumContributions: 3,
            deadlineMs: 60_000,
            maximumRevisions: 2,
          },
          humanGatePolicy: { mode: "on_escalation" },
        },
      ],
    } as const

    const normalized = normalizeWorkflowDefinition(definition)

    expect(normalized).toEqual(definition)
    expect(canonicalSha256(normalized)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("rejects unsafe artifact path templates during definition normalization", () => {
    for (const pathTemplate of [
      "/tmp/questions.md",
      "../questions.md",
      "docs/../questions.md",
      "docs/.git/config",
      "docs\\qrspi\\questions.md",
      "C:/tmp/questions.md",
    ]) {
      expect(() => normalizeWorkflowDefinition(workflowDefinition(pathTemplate))).toThrow(
        expect.objectContaining({ reason: "unsafe_artifact_path" }),
      )
    }
  })

  test("rejects workflow definitions without an enabled runnable stage", () => {
    expect(() =>
      normalizeWorkflowDefinition({ contractVersion: 1, definitionVersion: 1, stages: [] }),
    ).toThrow(expect.objectContaining({ reason: "no_considered_stage" }))
  })

  test("rejects malformed stable contract and harness references", () => {
    const definition = workflowDefinition("docs/qrspi/{ticketId}/questions.md")

    for (const stage of [
      { ...definition.stages[0], contract: { name: "", contractVersion: 1 } },
      {
        ...definition.stages[0],
        producer: {
          ...definition.stages[0]!.producer,
          harness: { name: "invalid harness", version: 1 },
        },
      },
    ]) {
      expect(() =>
        normalizeWorkflowDefinition({ ...definition, stages: [stage] }),
      ).toThrow()
    }
  })

  test("requires a bounded non-empty reason for conditional activation", () => {
    const definition = workflowDefinition("docs/qrspi/{ticketId}/questions.md")

    for (const reason of ["", "x".repeat(1_001)]) {
      expect(() =>
        normalizeWorkflowDefinition({
          ...definition,
          stages: [
            {
              ...definition.stages[0],
              activation: {
                mode: "conditional",
                policy: { name: "qrspi.activation", version: 1 },
                decision: "enabled",
                reason,
              },
            },
          ],
        }),
      ).toThrow()
    }
  })

  test.each([
    {
      name: "an empty workflow",
      stages: [],
      reason: "no_considered_stage",
    },
    {
      name: "a workflow with no effectively enabled stage",
      stages: [
        {
          ...workflowDefinition("docs/qrspi/{ticketId}/questions.md").stages[0],
          activation: { mode: "disabled" },
        },
      ],
      reason: "no_runnable_stage",
    },
    {
      name: "a disabled Design stage",
      stages: [
        workflowDefinition("docs/qrspi/{ticketId}/questions.md").stages[0],
        {
          ...workflowDefinition("docs/qrspi/{ticketId}/questions.md").stages[0],
          key: "design",
          contract: { name: "qrspi.design", contractVersion: 1 },
          activation: { mode: "disabled" },
        },
      ],
      reason: "invalid_activation_prerequisite",
      stageKey: "design",
      sequencePosition: 2,
    },
    {
      name: "Structure before Design",
      stages: [
        {
          ...workflowDefinition("docs/qrspi/{ticketId}/questions.md").stages[0],
          key: "structure",
          contract: { name: "qrspi.structure", contractVersion: 1 },
        },
      ],
      reason: "invalid_stage_order",
      stageKey: "structure",
      sequencePosition: 1,
    },
    {
      name: "a specialized policy on the wrong stage",
      stages: [
        {
          ...workflowDefinition("docs/qrspi/{ticketId}/questions.md").stages[0],
          designPolicy: { name: "qrspi.design-policy", version: 1 },
        },
      ],
      reason: "unsupported_policy",
      stageKey: "questions",
      sequencePosition: 1,
    },
  ])("reports stable pure diagnostics for $name", (fixture) => {
    let failure: unknown
    try {
      normalizeWorkflowDefinition({
        contractVersion: 1,
        definitionVersion: 1,
        stages: fixture.stages,
      })
    } catch (cause) {
      failure = cause
    }

    expect(failure).toMatchObject({
      _tag: "WorkflowDefinitionValidationError",
      phase: "pure",
      reason: fixture.reason,
      workflowDefinitionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      ...(fixture.stageKey === undefined ? {} : { stageKey: fixture.stageKey }),
      ...(fixture.sequencePosition === undefined
        ? {}
        : { sequencePosition: fixture.sequencePosition }),
    })
  })
})

function readyTicket() {
  return {
    reference,
    issueType: "feature" as const,
    title: "Start workflow",
    description: "Create a durable workflow from an authorized product ticket.",
    userStory: "As a maintainer, I want kickoff, so that work survives.",
    sources: ["docs/qrspi-contract.md"],
    acceptanceCriteria: ["A durable generation is created."],
    scenarios: [
      {
        name: "Start",
        given: "a ready ticket",
        when: "kickoff is requested",
        then: "a generation exists",
      },
    ],
  }
}

function workflowDefinition(pathTemplate: string) {
  return {
    contractVersion: 1,
    definitionVersion: 1,
    stages: [
      {
        key: "questions",
        kind: "document",
        contract: { name: "qrspi.questions", contractVersion: 1 },
        activation: { mode: "enabled" },
        definitionVersion: 1,
        maxEncodedInputBytes: 16_384,
        producer: {
          harness: { name: "opencode", version: 1 },
          agent: "qrspi-questions",
          model: "openai/gpt-5.6-sol",
          timeoutMs: 60_000,
          retry: { maxAttempts: 1, backoffMs: 1_000 },
        },
        outputPolicy: { _tag: "Artifact", pathTemplate, mediaType: "text/markdown" },
        reviewPolicy: { mode: "none" },
        humanGatePolicy: { mode: "none" },
      },
    ],
  }
}
