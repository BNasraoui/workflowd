import { defineSpec, requirement, rule, source } from "@quality-sh/provenance"
import { assembleExactStageSources } from "../src/qrspi/source-assembly"
import { validatePersistedSnapshots } from "../src/qrspi/stage-catalog"
import * as workflowStartRuntime from "../src/qrspi/workflow-start"

const qrspiContract = source("qrspi-contract").document("docs/qrspi-contract.md")

const stageRuntimeDesign = source("stage-runtime-design").document(
  "docs/qrspi-stage-runtime-design.md",
)

const exactStageContractDesign = source("exact-stage-contract-design").document(
  "docs/design/qrspi-exact-typed-stage-contracts.md",
)

const persistedCompatibility = rule("persisted-compatibility")
  .statement(
    "Persisted stage snapshots must still match an available compatible trusted registration before work can resume",
  )
  .implementedBy(validatePersistedSnapshots)

export const qrspiSpec = defineSpec("qrspi-runtime")
  .requirements(
    requirement("trusted-stage-execution")
      .statement(
        "QRSPI executes each stage through the exact trusted contract selected by its persisted identity",
      )
      .from(qrspiContract, stageRuntimeDesign)
      .rules(
        rule("exact-contract-selection").statement(
          "Stage dispatch invokes only the closures registered for the exact selected contract name and version",
        ),
        rule("complete-registration-identity").statement(
          "A trusted stage registration identity changes when its executable implementation revision changes",
        ),
        persistedCompatibility,
      ),
    requirement("exact-replay-authority")
      .statement(
        "QRSPI retries and restarts from bounded immutable ticket and predecessor authority without mutable rediscovery",
      )
      .from(qrspiContract, exactStageContractDesign)
      .rules(
        rule("ordered-predecessors")
          .statement(
            "A stage receives every enabled accepted predecessor exactly once in the contract-defined authority order",
          )
          .implementedBy(assembleExactStageSources),
        rule("immutable-source-bytes")
          .statement(
            "Repository source bytes must match the accepted commit, path, blob, content hash, and repository identity before use",
          )
          .implementedBy(assembleExactStageSources),
        rule("persisted-request-replay").statement(
          "Retry and restart rebuild a stage from its persisted exact request without rereading mutable repository or tracker state",
        ),
        rule("ticket-revision-verification").statement(
          "Task construction rejects a missing, malformed, semantically changed, or differently scoped ticket revision",
        ),
        persistedCompatibility,
      ),
    requirement("safe-workflow-start")
      .statement(
        "Workflow start creates one current generation only from ready product intent and an exact review target",
      )
      .from(qrspiContract, stageRuntimeDesign)
      .rules(
        rule("not-ready-is-non-mutating")
          .statement(
            "A ticket that needs product work creates no branch, generation, stage, or technical session",
          )
          .implementedBy(workflowStartRuntime.makeWorkflowStart),
        rule("idempotent-kickoff")
          .statement(
            "Repeated kickoff for the same repository, ticket revision, and target resolves to the same logical start operation",
          )
          .implementedBy(workflowStartRuntime.makeWorkflowStart),
        rule("open-pr-blocks-start")
          .statement(
            "An open pull request for the ticket branch prevents Workflowd from mutating that branch or creating a generation",
          )
          .implementedBy(workflowStartRuntime.makeWorkflowStart),
        rule("observe-uncertain-creation")
          .statement(
            "An unknown branch-creation outcome is observed before Workflowd retries the external mutation",
          )
          .implementedBy(workflowStartRuntime.makeWorkflowStart),
        rule("changed-ticket-supersedes-start")
          .statement(
            "If the ready ticket changes before start completes, the older start is superseded and cannot create current work",
          )
          .implementedBy(workflowStartRuntime.makeWorkflowStart),
      ),
    requirement("agent-contract-fidelity")
      .statement(
        "Stage agents apply the exact canonical QRSPI contract through a generated hash-bound bundled reference",
      )
      .from(qrspiContract)
      .rules(
        rule("bundled-contract-hash-match").statement(
          "The bundled Design and Structure skill reference is generated from the canonical contract and records that contract's exact SHA-256",
        ),
      ),
    requirement("authoritative-stage-progression")
      .statement(
        "Only confirmed current Workflowd publication may advance a QRSPI stage or generation",
      )
      .from(qrspiContract, stageRuntimeDesign)
      .rules(
        rule("harness-cannot-publish").statement(
          "A trusted stage harness may return bounded candidate output but cannot publish commits or advance workflow state",
        ),
        rule("publication-gates-progression").statement(
          "Stage and generation cursors advance only after Workflowd confirms publication of the expected signed exact-parent commit",
        ),
        rule("uncertain-publication-blocks").statement(
          "An uncertain or stale publication outcome must be observed and reconciled without advancing its stage or generation",
        ),
      ),
  )
  .build()

const trustedStage = qrspiSpec.requirements["trusted-stage-execution"]
const exactReplay = qrspiSpec.requirements["exact-replay-authority"]
const workflowStart = qrspiSpec.requirements["safe-workflow-start"]
const agentContractFidelity = qrspiSpec.requirements["agent-contract-fidelity"]

export const bundledContractMatchesCanonicalContract =
  agentContractFidelity.rules["bundled-contract-hash-match"]

export const catalogIdentityIncludesExecutableRevision =
  trustedStage.rules["complete-registration-identity"]
export const persistedSnapshotMustRemainCompatible = trustedStage.rules["persisted-compatibility"]
export const orderedPredecessorsAreExact = exactReplay.rules["ordered-predecessors"]
export const ticketRevisionIsHashVerified = exactReplay.rules["ticket-revision-verification"]
export const notReadyCreatesNoTechnicalWork = workflowStart.rules["not-ready-is-non-mutating"]
export const kickoffIsIdempotent = workflowStart.rules["idempotent-kickoff"]
export const openPullRequestBlocksBranchMutation = workflowStart.rules["open-pr-blocks-start"]
export const uncertainCreationIsObservedBeforeRetry =
  workflowStart.rules["observe-uncertain-creation"]
export const changedTicketSupersedesStart = workflowStart.rules["changed-ticket-supersedes-start"]
