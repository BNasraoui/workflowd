import { createHash } from "node:crypto"
import { Data, Effect, Schema } from "effect"
import {
  AcceptedPredecessorPointer,
  ExactStageScope,
  ExactStageSources,
  MAX_STAGE_SOURCE_BYTES,
  RepositoryTarget,
  RevisionIntent,
  TicketRevisionReference,
  compareAcceptedPredecessorCurrentness,
  type ExactArtifactSource,
  type StageSourceRole,
} from "./contracts/common"
import {
  ExecutableStageSnapshot,
  WorkflowDefinition,
  canonicalSha256,
  isEffectivelyEnabled,
  stageDefinitionSha256,
  stageSnapshotsMatchWorkflowDefinition,
  workflowDefinitionSha256,
  type RepositoryReference,
} from "./domain"
import type { QrspiRepositoryError, QrspiRepositoryPort } from "./ports"

export class StageSourceAssemblyError extends Data.TaggedError("StageSourceAssemblyError")<{
  readonly reason:
    | "malformed_authority"
    | "selected_snapshot_mismatch"
    | "missing_pointer"
    | "extra_pointer"
    | "ordered_pointer_mismatch"
    | "identity_mismatch"
    | "observation_mismatch"
    | "malformed_utf8"
    | "content_hash_mismatch"
  readonly role?: StageSourceRole
  readonly index?: number
  readonly expected?: unknown
  readonly actual?: unknown
  readonly cause?: string
}> {}

export const assembleExactStageSources = (input: {
  readonly scope: ExactStageScope
  readonly ticketRevision: typeof TicketRevisionReference.Type
  readonly target: typeof RepositoryTarget.Type
  readonly workflowDefinition: typeof WorkflowDefinition.Type
  readonly snapshots: ReadonlyArray<typeof ExecutableStageSnapshot.Type>
  readonly acceptedPointers: ReadonlyArray<unknown>
  readonly currentAcceptedPointers: ReadonlyArray<unknown>
  readonly revisionIntent?: unknown
  readonly maxSourceBytes: number
  readonly repository: QrspiRepositoryPort
}): Effect.Effect<ExactStageSources, StageSourceAssemblyError | QrspiRepositoryError> =>
  Effect.gen(function* () {
    const authority = yield* Effect.try({
      try: () => decodeAuthority(input),
      catch: (cause) =>
        cause instanceof StageSourceAssemblyError
          ? cause
          : new StageSourceAssemblyError({
              reason: "malformed_authority",
              cause: String(cause),
            }),
    })
    const sources = yield* Effect.forEach(
      authority.pointers,
      (pointer, index) =>
        readSource(
          input.repository,
          pointer,
          index,
          Math.min(input.maxSourceBytes, MAX_STAGE_SOURCE_BYTES),
        ),
      { concurrency: 1 },
    )
    const sourceSetSha256 = canonicalSha256(
      sources.map(({ role, artifact }) => ({ role, artifact })),
    )
    return yield* Schema.decodeUnknown(ExactStageSources)({
      ...authority.scope,
      ticketRevision: authority.ticketRevision,
      sources,
      sourceSetSha256,
      target: authority.target,
      ...(authority.revisionIntent === undefined
        ? {}
        : { revisionIntent: authority.revisionIntent }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StageSourceAssemblyError({ reason: "malformed_authority", cause: String(cause) }),
      ),
    )
  })

function decodeAuthority(input: {
  readonly scope: ExactStageScope
  readonly ticketRevision: typeof TicketRevisionReference.Type
  readonly target: typeof RepositoryTarget.Type
  readonly workflowDefinition: typeof WorkflowDefinition.Type
  readonly snapshots: ReadonlyArray<typeof ExecutableStageSnapshot.Type>
  readonly acceptedPointers: ReadonlyArray<unknown>
  readonly currentAcceptedPointers: ReadonlyArray<unknown>
  readonly revisionIntent?: unknown
}) {
  const scope = Schema.decodeUnknownSync(ExactStageScope)(input.scope)
  const ticketRevision = Schema.decodeUnknownSync(TicketRevisionReference)(input.ticketRevision)
  const target = Schema.decodeUnknownSync(RepositoryTarget)(input.target)
  const workflowDefinition = Schema.decodeUnknownSync(WorkflowDefinition)(input.workflowDefinition)
  const snapshots = Schema.decodeUnknownSync(Schema.Array(ExecutableStageSnapshot))(input.snapshots)
  const pointers = Schema.decodeUnknownSync(Schema.Array(AcceptedPredecessorPointer))(
    input.acceptedPointers,
  )
  const currentPointers = Schema.decodeUnknownSync(Schema.Array(AcceptedPredecessorPointer))(
    input.currentAcceptedPointers,
  )
  const revisionIntent =
    input.revisionIntent === undefined
      ? undefined
      : Schema.decodeUnknownSync(RevisionIntent)(input.revisionIntent)
  if (
    scope.workflowDefinitionSha256 !== workflowDefinitionSha256(workflowDefinition) ||
    !stageSnapshotsMatchWorkflowDefinition(workflowDefinition, snapshots)
  ) {
    throw new StageSourceAssemblyError({ reason: "selected_snapshot_mismatch" })
  }
  const selectedIndex = snapshots.findIndex(
    (snapshot) =>
      snapshot.definition.key === scope.stageKey &&
      snapshot.stageDefinitionSha256 === scope.stageDefinitionSha256,
  )
  if (selectedIndex < 0) {
    throw new StageSourceAssemblyError({ reason: "selected_snapshot_mismatch" })
  }
  if (
    snapshots.some(
      (snapshot, index) =>
        snapshot.sequencePosition !== index + 1 ||
        snapshot.stageDefinitionSha256 !== stageDefinitionSha256(snapshot.definition),
    )
  ) {
    throw new StageSourceAssemblyError({ reason: "selected_snapshot_mismatch" })
  }
  const expected = snapshots
    .slice(0, selectedIndex)
    .filter((snapshot) => isEffectivelyEnabled(snapshot.definition))
    .flatMap((snapshot) => {
      const role = roleFor(snapshot.definition.key)
      return role === undefined ? [] : [{ role, snapshot }]
    })
    .reverse()
  validatePointers(pointers, currentPointers, expected, scope, target)
  if (ticketRevision.workflowId !== scope.workflowId) {
    throw identityError(undefined, undefined, scope.workflowId, ticketRevision.workflowId)
  }
  return { scope, ticketRevision, target, pointers, revisionIntent }
}

function validatePointers(
  pointers: ReadonlyArray<AcceptedPredecessorPointer>,
  currentPointers: ReadonlyArray<AcceptedPredecessorPointer>,
  expected: ReadonlyArray<{
    readonly role: StageSourceRole
    readonly snapshot: typeof ExecutableStageSnapshot.Type
  }>,
  scope: ExactStageScope,
  target: typeof RepositoryTarget.Type,
): void {
  if (pointers.length < expected.length) {
    const role = expected[pointers.length]?.role
    throw new StageSourceAssemblyError({
      reason: "missing_pointer",
      index: pointers.length,
      ...(role === undefined ? {} : { role }),
    })
  }
  if (pointers.length > expected.length) {
    const role = pointers[expected.length]?.role
    throw new StageSourceAssemblyError({
      reason: "extra_pointer",
      index: expected.length,
      ...(role === undefined ? {} : { role }),
    })
  }
  if (currentPointers.length !== expected.length) {
    throw identityError(undefined, undefined, expected.length, currentPointers.length)
  }
  for (const [index, expectedSource] of expected.entries()) {
    const pointer = pointers[index]!
    const currentPointer = currentPointers[index]!
    const currentMismatch = pointerMismatch(currentPointer, expectedSource, scope, target)
    if (currentMismatch !== undefined) throw currentMismatch
    if (compareAcceptedPredecessorCurrentness(currentPointer, pointer, index) !== undefined) {
      throw identityError(expectedSource.role, index, currentPointer, pointer)
    }
    const mismatch = pointerMismatch(pointer, expectedSource, scope, target)
    if (mismatch !== undefined) throw mismatch
  }
}

function pointerMismatch(
  pointer: AcceptedPredecessorPointer,
  expected: {
    readonly role: StageSourceRole
    readonly snapshot: typeof ExecutableStageSnapshot.Type
  },
  scope: ExactStageScope,
  target: typeof RepositoryTarget.Type,
): StageSourceAssemblyError | undefined {
  const { snapshot } = expected
  const artifact = pointer.artifact
  if (pointer.role !== expected.role)
    return new StageSourceAssemblyError({
      reason: "ordered_pointer_mismatch",
      role: expected.role,
      index: snapshot.sequencePosition - 1,
      expected: expected.role,
      actual: pointer.role,
    })
  const mismatch = (wanted: unknown, actual: unknown) =>
    identityError(expected.role, snapshot.sequencePosition - 1, wanted, actual)
  if (pointer.snapshotSha256 !== snapshot.stageDefinitionSha256)
    return mismatch(snapshot.stageDefinitionSha256, pointer.snapshotSha256)
  if (artifact.workflowId !== scope.workflowId)
    return mismatch(scope.workflowId, artifact.workflowId)
  if (artifact.generation !== scope.generation)
    return mismatch(scope.generation, artifact.generation)
  if (!sameRepositoryAuthority(artifact.repository, target.repository))
    return mismatch(target.repository, artifact.repository)
  if (artifact.stageKey !== snapshot.definition.key)
    return mismatch(snapshot.definition.key, artifact.stageKey)
  if (pointer.acceptedStageRevision !== artifact.stageRevision)
    return mismatch(pointer.acceptedStageRevision, artifact.stageRevision)
  if (
    canonicalSha256({
      contract: pointer.contract,
      registration: pointer.contractRegistrationSha256,
    }) !==
    canonicalSha256({
      contract: snapshot.definition.contract,
      registration: snapshot.contractRegistrationSha256,
    })
  )
    return mismatch(
      {
        contract: snapshot.definition.contract,
        registration: snapshot.contractRegistrationSha256,
      },
      { contract: pointer.contract, registration: pointer.contractRegistrationSha256 },
    )
  if (
    snapshot.definition.outputPolicy._tag !== "Artifact" ||
    artifact.mediaType !== snapshot.definition.outputPolicy.mediaType
  )
    return mismatch(
      snapshot.definition.outputPolicy._tag === "Artifact"
        ? snapshot.definition.outputPolicy.mediaType
        : "Artifact",
      artifact.mediaType,
    )
  return undefined
}

function readSource(
  repository: QrspiRepositoryPort,
  pointer: AcceptedPredecessorPointer,
  index: number,
  maxSourceBytes: number,
) {
  return Effect.gen(function* () {
    const observed = yield* repository.readArtifact({
      repository: pointer.artifact.repository,
      commitSha: pointer.artifact.commitSha,
      path: pointer.artifact.path,
      maxBytes: maxSourceBytes,
    })
    const diagnostic = { role: pointer.role, index }
    for (const [field, expected, actual] of [
      ["commit", pointer.artifact.commitSha, observed.commitSha],
      ["path", pointer.artifact.path, observed.path],
      ["blob", pointer.artifact.blobSha, observed.blobSha],
    ] as const) {
      if (expected !== actual)
        return yield* Effect.fail(
          new StageSourceAssemblyError({
            reason: "observation_mismatch",
            ...diagnostic,
            expected: { field, value: expected },
            actual: { field, value: actual },
          }),
        )
    }
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes),
      catch: (cause) =>
        new StageSourceAssemblyError({
          reason: "malformed_utf8",
          ...diagnostic,
          cause: String(cause),
        }),
    })
    const contentSha256 = createHash("sha256").update(observed.bytes).digest("hex")
    if (contentSha256 !== pointer.artifact.contentSha256) {
      return yield* Effect.fail(
        new StageSourceAssemblyError({
          reason: "content_hash_mismatch",
          ...diagnostic,
          expected: pointer.artifact.contentSha256,
          actual: contentSha256,
        }),
      )
    }
    return {
      role: pointer.role,
      artifact: pointer.artifact,
      acceptedPointer: pointer,
      content,
    } satisfies ExactArtifactSource
  })
}

const sourceRoleByStageKey: Readonly<Record<string, StageSourceRole>> = {
  questions: "Questions",
  research: "Research",
  design: "Design",
  structure: "Structure",
  plan: "Plan",
  implementation: "Implementation",
}

function roleFor(stageKey: string): StageSourceRole | undefined {
  return sourceRoleByStageKey[stageKey]
}

function sameRepositoryAuthority(left: RepositoryReference, right: RepositoryReference): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId && left.repositoryId === right.repositoryId
  )
}

function identityError(
  role: StageSourceRole | undefined,
  index: number | undefined,
  expected: unknown,
  actual: unknown,
) {
  return new StageSourceAssemblyError({
    reason: "identity_mismatch",
    ...(role === undefined ? {} : { role }),
    ...(index === undefined ? {} : { index }),
    expected,
    actual,
  })
}
