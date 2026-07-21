import { createHash } from "node:crypto"
import { Schema } from "effect"

const BoundedText = (maximum: number) =>
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximum))
const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))
const GitSha = Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))

export const RepositoryReference = Schema.Struct({
  providerInstanceId: BoundedText(128),
  repositoryId: BoundedText(128),
  repositoryFullName: Schema.String.pipe(
    Schema.pattern(/^[^/\s]+\/[^/\s]+$/),
    Schema.maxLength(256),
  ),
})
export type RepositoryReference = typeof RepositoryReference.Type

export const TicketReference = Schema.Struct({
  tracker: Schema.Literal("beads"),
  trackerInstanceId: BoundedText(128),
  nativeTicketId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
})
export type TicketReference = typeof TicketReference.Type

const RawText = (maximum: number) => Schema.String.pipe(Schema.maxLength(maximum))
const OptionalRawText = (maximum: number) => Schema.optional(RawText(maximum))

export const TicketScenario = Schema.Struct({
  name: OptionalRawText(200),
  given: OptionalRawText(2_000),
  when: OptionalRawText(2_000),
  then: OptionalRawText(2_000),
  covers: Schema.optional(
    Schema.Array(Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(99))).pipe(
      Schema.maxItems(100),
    ),
  ),
})

const ReadyTicketScenario = Schema.Struct({
  name: BoundedText(200),
  given: BoundedText(2_000),
  when: BoundedText(2_000),
  then: BoundedText(2_000),
  covers: TicketScenario.fields.covers,
})

export const Ticket = Schema.Struct({
  reference: TicketReference,
  issueType: Schema.Literal("bug", "feature", "task", "epic", "chore", "decision"),
  title: OptionalRawText(500),
  userStory: OptionalRawText(4_000),
  description: OptionalRawText(20_000),
  sources: Schema.optional(Schema.Array(RawText(2_000)).pipe(Schema.maxItems(100))),
  outOfScope: Schema.optional(Schema.Array(RawText(4_000)).pipe(Schema.maxItems(100))),
  acceptanceCriteria: Schema.optional(Schema.Array(RawText(4_000)).pipe(Schema.maxItems(100))),
  scenarios: Schema.optional(Schema.Array(TicketScenario).pipe(Schema.maxItems(100))),
  sourceRevision: Schema.optional(BoundedText(256)),
})
export type Ticket = typeof Ticket.Type

export const ReadyTicket = Schema.Struct({
  ...Ticket.fields,
  title: BoundedText(500),
  description: BoundedText(20_000),
  sources: Schema.Array(BoundedText(2_000)).pipe(Schema.minItems(1), Schema.maxItems(100)),
  acceptanceCriteria: Schema.Array(BoundedText(4_000)).pipe(
    Schema.minItems(1),
    Schema.maxItems(100),
  ),
  scenarios: Schema.Array(ReadyTicketScenario).pipe(Schema.minItems(1), Schema.maxItems(100)),
})
export type ReadyTicket = typeof ReadyTicket.Type

export const TicketProblemCode = Schema.Literal(
  "missing_title",
  "unclear_title",
  "missing_description",
  "unclear_product_outcome",
  "missing_user_story",
  "inappropriate_user_story",
  "missing_acceptance_criteria",
  "unobservable_acceptance_criterion",
  "missing_scenarios",
  "invalid_scenario",
  "uncovered_acceptance_criterion",
  "unresolved_source",
  "contradictory_product_direction",
)
export const TicketProblem = Schema.Struct({ code: TicketProblemCode, message: BoundedText(1_000) })
export type TicketProblem = typeof TicketProblem.Type

export const TicketRevision = Schema.Struct({
  readyTicket: ReadyTicket,
  scenarioCoverage: Schema.Array(Schema.Array(Schema.Int.pipe(Schema.nonNegative()))),
  sourceRevision: Schema.optional(BoundedText(256)),
  checkedAt: Schema.DateFromSelf,
  ticketRevisionSha256: Sha256,
})
export type TicketRevision = typeof TicketRevision.Type

export const TicketCheck = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Ready"),
    readyTicket: ReadyTicket,
    ticketRevision: TicketRevision,
    checkedAt: Schema.DateFromSelf,
  }),
  Schema.Struct({
    _tag: Schema.Literal("NeedsWork"),
    ticket: Ticket,
    problems: Schema.NonEmptyArray(TicketProblem),
    checkedAt: Schema.DateFromSelf,
  }),
)
export type TicketCheck = typeof TicketCheck.Type

export const TicketReadinessJudgment = Schema.Struct({
  userStory: Schema.Literal("required", "optional", "forbidden"),
  productDirection: Schema.Literal("consistent", "contradictory"),
  productOutcome: Schema.Literal("clear", "unclear"),
  acceptanceCriteriaObservability: Schema.Array(Schema.Literal("observable", "unobservable")).pipe(
    Schema.maxItems(100),
  ),
  scenarioCoverage: Schema.Array(
    Schema.Array(Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(99))).pipe(
      Schema.maxItems(100),
    ),
  ).pipe(Schema.maxItems(100)),
})
export type TicketReadinessJudgment = typeof TicketReadinessJudgment.Type

export const WorkflowStartRequest = Schema.Struct({
  repository: RepositoryReference,
  ticket: TicketReference,
  readinessJudgment: TicketReadinessJudgment,
})
export type WorkflowStartRequest = typeof WorkflowStartRequest.Type

export const WorkflowStartInput = Schema.Struct({
  contractVersion: Schema.Literal(1),
  repository: RepositoryReference,
  ticket: TicketReference,
  ticketRevisionSha256: Sha256,
  workflowDefinitionSha256: Sha256,
  baseRef: BoundedText(256),
  baseSha: GitSha,
  branchName: BoundedText(256),
})

export const WorkflowInitialOperationDefinition = Schema.Struct({
  kind: Schema.Literal("StageProduce", "ArtifactPublish"),
  state: Schema.Literal("ready", "blocked"),
  parentEffect: Schema.Struct({
    success: Schema.Literal("advance parent", "audit only"),
    failure: Schema.Literal("fail Generation", "audit only"),
  }),
  parameters: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})

const ContractIdentifier = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/))
const PositiveVersion = Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1_000_000))
const BoundedMilliseconds = Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(86_400_000))

export const StageInputContract = Schema.Struct({
  schemaId: ContractIdentifier,
  schemaVersion: PositiveVersion,
  maxEncodedBytes: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1_048_576)),
})

export const StageProducerDefinition = Schema.Struct({
  harnessId: ContractIdentifier,
  harnessVersion: PositiveVersion,
  agent: ContractIdentifier,
  model: Schema.String.pipe(Schema.pattern(/^[^\s/]+\/[^\s/]+$/), Schema.maxLength(256)),
  timeoutMs: BoundedMilliseconds,
  retry: Schema.Struct({
    maxAttempts: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(20)),
    backoffMs: BoundedMilliseconds,
  }),
})

export const StageOutputContract = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Artifact"),
    pathTemplate: BoundedText(512),
    mediaType: BoundedText(128),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ImplementationCheckpoint"),
    contractId: ContractIdentifier,
    contractVersion: PositiveVersion,
  }),
)

export const StageReviewPolicy = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("none") }),
  Schema.Struct({
    mode: Schema.Literal("automated"),
    minimumContributions: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(20)),
    maximumContributions: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(20)),
    deadlineMs: BoundedMilliseconds,
    maximumRevisions: Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(20)),
  }),
)

export const StageHumanGatePolicy = Schema.Struct({
  mode: Schema.Literal("none", "required", "on_escalation"),
})

export const StageActivationPolicy = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("enabled", "disabled") }),
  Schema.Struct({
    mode: Schema.Literal("conditional"),
    policyId: ContractIdentifier,
    policyVersion: PositiveVersion,
    decision: Schema.Literal("enabled", "disabled"),
  }),
)

export const WorkflowStageDefinition = Schema.Struct({
  key: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_-]{0,63}$/)),
  kind: Schema.Literal("document", "implementation"),
  activation: StageActivationPolicy,
  definitionVersion: PositiveVersion,
  inputContract: StageInputContract,
  producer: StageProducerDefinition,
  outputContract: StageOutputContract,
  reviewPolicy: StageReviewPolicy,
  humanGatePolicy: StageHumanGatePolicy,
  initialOperations: Schema.Array(WorkflowInitialOperationDefinition).pipe(Schema.maxItems(16)),
})

export const WorkflowDefinition = Schema.Struct({
  contractVersion: Schema.Literal(1),
  definitionVersion: PositiveVersion,
  stages: Schema.Array(WorkflowStageDefinition).pipe(Schema.maxItems(32)),
})
export type WorkflowDefinition = typeof WorkflowDefinition.Type
export type SourceResolver = (source: string) => boolean

export function workflowDefinitionSha256(definition: WorkflowDefinition): string {
  return canonicalSha256({
    contractVersion: definition.contractVersion,
    normalizationVersion: "RFC8785-NFC-1",
    definition,
  })
}

export function normalizeWorkflowDefinition(input: unknown): WorkflowDefinition {
  const definition = Schema.decodeUnknownSync(WorkflowDefinition)(input)
  if (
    !definition.stages.some(
      (stage) =>
        stage.activation.mode === "enabled" ||
        (stage.activation.mode === "conditional" && stage.activation.decision === "enabled"),
    )
  ) {
    throw new Error("Workflow definition must contain at least one runnable stage")
  }
  const keys = new Set<string>()
  for (const stage of definition.stages) {
    if (keys.has(stage.key)) throw new Error(`Duplicate workflow stage key: ${stage.key}`)
    keys.add(stage.key)
    const operationKinds = new Set<string>()
    for (const operation of stage.initialOperations) {
      if (operationKinds.has(operation.kind)) {
        throw new Error(`Duplicate initial ${operation.kind} operation for stage: ${stage.key}`)
      }
      operationKinds.add(operation.kind)
    }
    if (!operationKinds.has("StageProduce") || !operationKinds.has("ArtifactPublish")) {
      throw new Error(
        `Workflow stage must declare StageProduce and ArtifactPublish operations: ${stage.key}`,
      )
    }
    if (
      (stage.activation.mode === "enabled" ||
        (stage.activation.mode === "conditional" && stage.activation.decision === "enabled")) &&
      !stage.initialOperations.some((operation) => operation.state === "ready")
    ) {
      throw new Error(`Workflow definition has no runnable stage operation: ${stage.key}`)
    }
    if (
      stage.reviewPolicy.mode === "automated" &&
      stage.reviewPolicy.minimumContributions > stage.reviewPolicy.maximumContributions
    ) {
      throw new Error(`Stage review minimum exceeds maximum: ${stage.key}`)
    }
    if (
      stage.outputContract._tag === "Artifact" &&
      !isSafeArtifactPathTemplate(stage.outputContract.pathTemplate)
    ) {
      throw new Error(`Invalid artifact path template for stage: ${stage.key}`)
    }
  }
  return definition
}

function isSafeArtifactPathTemplate(pathTemplate: string): boolean {
  if (
    pathTemplate.startsWith("/") ||
    pathTemplate.includes("\\") ||
    /^[A-Za-z]:/.test(pathTemplate)
  ) {
    return false
  }
  const segments = pathTemplate.split("/")
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      segment.toLowerCase() !== ".git" &&
      /^(?:[A-Za-z0-9._-]|\{(?:ticketId|stageKey)\})+$/.test(segment),
  )
}

export const WorkflowStartOutput = Schema.Struct({
  _tag: Schema.Literal("Started"),
  workflowId: BoundedText(256),
  generation: Schema.Int.pipe(Schema.positive()),
  branchName: BoundedText(256),
  rootSha: GitSha,
  ticketRevisionSha256: Sha256,
})
export type WorkflowStartOutput = typeof WorkflowStartOutput.Type

export function workflowIdFor(repository: RepositoryReference, ticket: TicketReference): string {
  return `wf_${canonicalSha256({
    contractVersion: 1,
    repository: {
      providerInstanceId: repository.providerInstanceId,
      repositoryId: repository.repositoryId,
    },
    ticket: {
      tracker: ticket.tracker,
      trackerInstanceId: ticket.trackerInstanceId,
      nativeTicketId: ticket.nativeTicketId,
    },
  })}`
}

function problem(code: TicketProblem["code"], message: string): TicketProblem {
  return { code, message }
}

export function checkTicket(
  ticket: Ticket,
  checkedAt: Date,
  judgment: TicketReadinessJudgment,
  resolveSource: SourceResolver = () => false,
): TicketCheck {
  const problems: TicketProblem[] = []
  if (ticket.title === undefined || ticket.title.trim() === "")
    problems.push(problem("missing_title", "Add a title naming the change."))
  else if (isLowInformation(ticket.title))
    problems.push(problem("unclear_title", "Replace the placeholder with a specific title."))
  if (ticket.description === undefined || ticket.description.trim() === "")
    problems.push(
      problem("missing_description", "Describe current behavior and the desired outcome."),
    )
  else if (isLowInformation(ticket.description) || judgment.productOutcome === "unclear")
    problems.push(
      problem("unclear_product_outcome", "Replace the placeholder with a product outcome."),
    )
  if (judgment.userStory === "required" && !ticket.userStory?.trim())
    problems.push(problem("missing_user_story", "Add the actor, capability, and value."))
  if (judgment.userStory === "forbidden" && ticket.userStory?.trim())
    problems.push(
      problem("inappropriate_user_story", "Remove the user story when it does not help the work."),
    )
  if (judgment.productDirection === "contradictory")
    problems.push(
      problem(
        "contradictory_product_direction",
        "Resolve the contradictory product direction before starting technical work.",
      ),
    )
  if (ticket.acceptanceCriteria === undefined || ticket.acceptanceCriteria.length === 0)
    problems.push(problem("missing_acceptance_criteria", "Add observable acceptance criteria."))
  else if (
    ticket.acceptanceCriteria.some(
      (criterion, index) =>
        isUnobservableCriterion(criterion) ||
        judgment.acceptanceCriteriaObservability[index] !== "observable",
    )
  )
    problems.push(
      problem("unobservable_acceptance_criterion", "Make every acceptance criterion observable."),
    )
  if (ticket.scenarios === undefined || ticket.scenarios.length === 0)
    problems.push(problem("missing_scenarios", "Add named Given/When/Then scenarios."))
  else if (
    ticket.scenarios.some(
      (scenario) =>
        !scenario.name?.trim() ||
        !scenario.given?.trim() ||
        !scenario.when?.trim() ||
        !scenario.then?.trim() ||
        isLowInformation(scenario.name) ||
        isLowInformation(scenario.given) ||
        isLowInformation(scenario.when) ||
        isLowInformation(scenario.then),
    )
  )
    problems.push(problem("invalid_scenario", "Complete each named Given/When/Then scenario."))
  if (
    ticket.sources === undefined ||
    ticket.sources.length === 0 ||
    ticket.sources.some((source) => !sourceCanResolveLocally(source, resolveSource))
  )
    problems.push(problem("unresolved_source", "Add at least one resolvable source reference."))

  const criteria = ticket.acceptanceCriteria ?? []
  const scenarios = ticket.scenarios ?? []
  const scenarioCoverage = criteria.map((_, criterion) =>
    [...new Set(judgment.scenarioCoverage[criterion] ?? [])].filter(
      (scenario) => scenarios[scenario] !== undefined,
    ),
  )
  for (let index = 0; index < criteria.length; index += 1) {
    if (scenarioCoverage[index]?.length === 0) {
      problems.push(
        problem(
          "uncovered_acceptance_criterion",
          `Acceptance criterion ${index + 1} is not covered by a scenario.`,
        ),
      )
    }
  }
  if (problems.length > 0) {
    const [first, ...rest] = problems
    if (first === undefined) throw new Error("Ticket problem collection unexpectedly empty")
    return { _tag: "NeedsWork", ticket, problems: [first, ...rest], checkedAt }
  }

  const readyTicket = Schema.decodeUnknownSync(ReadyTicket)(ticket)
  const product = {
    issueType: readyTicket.issueType,
    title: readyTicket.title,
    ...(readyTicket.userStory === undefined ? {} : { userStory: readyTicket.userStory }),
    description: readyTicket.description,
    sources: readyTicket.sources,
    ...(readyTicket.outOfScope === undefined ? {} : { outOfScope: readyTicket.outOfScope }),
    acceptanceCriteria: readyTicket.acceptanceCriteria,
    scenarios: readyTicket.scenarios,
  }
  const normalized = normalize({
    contractVersion: 1,
    normalizationVersion: "RFC8785-NFC-1",
    product,
    scenarioCoverage,
  })
  const ticketRevisionSha256 = createHash("sha256").update(canonicalJson(normalized)).digest("hex")
  const ticketRevision: TicketRevision = {
    readyTicket,
    scenarioCoverage,
    ...(ticket.sourceRevision === undefined ? {} : { sourceRevision: ticket.sourceRevision }),
    checkedAt,
    ticketRevisionSha256,
  }
  return { _tag: "Ready", readyTicket, ticketRevision, checkedAt }
}

function isUnobservableCriterion(criterion: string): boolean {
  const normalized = criterion.trim().toLowerCase()
  return normalized === "" || isLowInformation(criterion) || normalized.startsWith("todo:")
}

function isLowInformation(value: string | undefined): boolean {
  if (value === undefined) return true
  const normalized = value.trim().toLowerCase()
  return (
    normalized === "x" ||
    normalized === "todo" ||
    normalized === "tbd" ||
    normalized === "unknown" ||
    normalized === "placeholder" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "none" ||
    (normalized !== "" && !/[\p{L}\p{N}]/u.test(normalized))
  )
}

function sourceCanResolveLocally(source: string, resolveSource: SourceResolver): boolean {
  const value = source.trim()
  const url = /https?:\/\/[^\s)>]+/.exec(value)?.[0]
  if (url !== undefined) {
    try {
      const parsed = new URL(url)
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") && resolveSource(parsed.href)
      )
    } catch {
      return false
    }
  }
  const fileReference = value.replace(/^\.\//, "")
  const fileSegments = fileReference.split("/")
  if (
    fileSegments.every(
      (segment) => segment !== "" && segment !== ".." && /^[A-Za-z0-9_.-]+$/.test(segment),
    ) &&
    (fileSegments.length > 1 || fileSegments[0]?.includes(".") === true)
  ) {
    return resolveSource(fileReference)
  }
  return (
    /^(?:beads|provenance|ticket):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    resolveSource(value)
  )
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(normalize(value)))
    .digest("hex")
}

function normalize(value: unknown): unknown {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error("Value is not valid JSON")
  }
  if (typeof value === "string") return value.normalize("NFC")
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    throw new Error("Canonical JSON rejects non-finite numbers and negative zero")
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    const entries: Array<readonly [string, unknown]> = []
    const keys = new Set<string>()
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.normalize("NFC")
      if (keys.has(normalizedKey)) throw new Error(`NFC normalization collision: ${normalizedKey}`)
      keys.add(normalizedKey)
      entries.push([normalizedKey, normalize(item)])
    }
    return Object.fromEntries(entries)
  }
  return value
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}
