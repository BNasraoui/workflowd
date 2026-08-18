import { defineSpec } from "@quality-sh/provenance"
import { assembleExactStageSources } from "../src/qrspi/source-assembly"
import { validatePersistedSnapshots } from "../src/qrspi/stage-catalog"
import * as workflowStartRuntime from "../src/qrspi/workflow-start"

const provenance = defineSpec("qrspi-runtime")

export const qrspiContract = provenance
  .source("qrspi-contract")
  .document("docs/qrspi-contract.md")

export const stageRuntimeDesign = provenance
  .source("stage-runtime-design")
  .document("docs/qrspi-stage-runtime-design.md")

export const exactStageContractDesign = provenance
  .source("exact-stage-contract-design")
  .document("docs/design/qrspi-exact-typed-stage-contracts.md")

const trustedStage = provenance
  .requirement("trusted-stage-execution")
  .statement(
    "QRSPI executes each stage through the exact trusted contract selected by its persisted identity",
  )
  .from(qrspiContract, stageRuntimeDesign)

export const catalogSelectsExactContract = trustedStage
  .rule("exact-contract-selection")
  .statement(
    "Stage dispatch invokes only the closures registered for the exact selected contract name and version",
  )

export const catalogIdentityIncludesExecutableRevision = trustedStage
  .rule("complete-registration-identity")
  .statement(
    "A trusted stage registration identity changes when its executable implementation revision changes",
  )

export const persistedSnapshotMustRemainCompatible = provenance
  .rule("persisted-compatibility")
  .statement(
    "Persisted stage snapshots must still match an available compatible trusted registration before work can resume",
  )
  .implementedBy(validatePersistedSnapshots)

export const trustedStageExecution = trustedStage.rules(
  catalogSelectsExactContract,
  catalogIdentityIncludesExecutableRevision,
  persistedSnapshotMustRemainCompatible,
)

const exactReplay = provenance
  .requirement("exact-replay-authority")
  .statement(
    "QRSPI retries and restarts from bounded immutable ticket and predecessor authority without mutable rediscovery",
  )
  .from(qrspiContract, exactStageContractDesign)

export const orderedPredecessorsAreExact = exactReplay
  .rule("ordered-predecessors")
  .statement(
    "A stage receives every enabled accepted predecessor exactly once in the contract-defined authority order",
  )
  .implementedBy(assembleExactStageSources)

export const sourceBytesMatchImmutableIdentity = exactReplay
  .rule("immutable-source-bytes")
  .statement(
    "Repository source bytes must match the accepted commit, path, blob, content hash, and repository identity before use",
  )
  .implementedBy(assembleExactStageSources)

export const replayUsesPersistedRequest = exactReplay
  .rule("persisted-request-replay")
  .statement(
    "Retry and restart rebuild a stage from its persisted exact request without rereading mutable repository or tracker state",
  )

export const ticketRevisionIsHashVerified = exactReplay
  .rule("ticket-revision-verification")
  .statement(
    "Task construction rejects a missing, malformed, semantically changed, or differently scoped ticket revision",
  )

export const exactReplayAuthority = exactReplay.rules(
  orderedPredecessorsAreExact,
  sourceBytesMatchImmutableIdentity,
  replayUsesPersistedRequest,
  ticketRevisionIsHashVerified,
  persistedSnapshotMustRemainCompatible,
)

const workflowStart = provenance
  .requirement("safe-workflow-start")
  .statement(
    "Workflow start creates one current generation only from ready product intent and an exact review target",
  )
  .from(qrspiContract, stageRuntimeDesign)

export const notReadyCreatesNoTechnicalWork = workflowStart
  .rule("not-ready-is-non-mutating")
  .statement(
    "A ticket that needs product work creates no branch, generation, stage, or technical session",
  )
  .implementedBy(workflowStartRuntime.makeWorkflowStart)

export const kickoffIsIdempotent = workflowStart
  .rule("idempotent-kickoff")
  .statement(
    "Repeated kickoff for the same repository, ticket revision, and target resolves to the same logical start operation",
  )
  .implementedBy(workflowStartRuntime.makeWorkflowStart)

export const openPullRequestBlocksBranchMutation = workflowStart
  .rule("open-pr-blocks-start")
  .statement(
    "An open pull request for the ticket branch prevents Workflowd from mutating that branch or creating a generation",
  )
  .implementedBy(workflowStartRuntime.makeWorkflowStart)

export const uncertainCreationIsObservedBeforeRetry = workflowStart
  .rule("observe-uncertain-creation")
  .statement(
    "An unknown branch-creation outcome is observed before Workflowd retries the external mutation",
  )
  .implementedBy(workflowStartRuntime.makeWorkflowStart)

export const changedTicketSupersedesStart = workflowStart
  .rule("changed-ticket-supersedes-start")
  .statement(
    "If the ready ticket changes before start completes, the older start is superseded and cannot create current work",
  )
  .implementedBy(workflowStartRuntime.makeWorkflowStart)

export const safeWorkflowStart = workflowStart.rules(
  notReadyCreatesNoTechnicalWork,
  kickoffIsIdempotent,
  openPullRequestBlocksBranchMutation,
  uncertainCreationIsObservedBeforeRetry,
  changedTicketSupersedesStart,
)

const stageProgression = provenance
  .requirement("authoritative-stage-progression")
  .statement("Only confirmed current Workflowd publication may advance a QRSPI stage or generation")
  .from(qrspiContract, stageRuntimeDesign)

export const stageHarnessHasNoPublicationAuthority = stageProgression
  .rule("harness-cannot-publish")
  .statement(
    "A trusted stage harness may return bounded candidate output but cannot publish commits or advance workflow state",
  )

export const publicationGatesProgression = stageProgression
  .rule("publication-gates-progression")
  .statement(
    "Stage and generation cursors advance only after Workflowd confirms publication of the expected signed exact-parent commit",
  )

export const uncertainPublicationDoesNotAdvance = stageProgression
  .rule("uncertain-publication-blocks")
  .statement(
    "An uncertain or stale publication outcome must be observed and reconciled without advancing its stage or generation",
  )

export const authoritativeStageProgression = stageProgression.rules(
  stageHarnessHasNoPublicationAuthority,
  publicationGatesProgression,
  uncertainPublicationDoesNotAdvance,
)

export const qrspiSpec = provenance.build(
  trustedStageExecution,
  exactReplayAuthority,
  safeWorkflowStart,
  authoritativeStageProgression,
)
