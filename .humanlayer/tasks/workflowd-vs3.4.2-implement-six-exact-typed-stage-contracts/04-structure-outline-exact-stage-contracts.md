---
task: workflowd-vs3.4.2-implement-six-exact-typed-stage-contracts
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-vs3.4.2
sha: e4af79f5568293542812d436341c4523baa55e06
---

# Implement Six Exact Typed Stage Contracts

Implement CAP-D2 as four vertical slices through the trusted catalog, exact authority inputs, task construction, result projection, and replay validation. The slices start with a replayable Questions request, add one immutable technical predecessor end to end, extend the same seam to the specialized document contracts, and finish with the distinct Implementation contract and complete live registration set.

## Desired End State

- Questions, Research, Design, Structure, Plan, and Implementation each own a distinct bounded, stage-tagged Effect request and result Schema.
- The trusted catalog is the only heterogeneous dispatch seam and invokes selected assemble, task, and prepare closures without a stage-key switch.
- Requests bind exact workflow, Generation, run/revision, definition, ticket-revision, accepted-source, repository-target, and applicable revision-intent identity.
- Accepted technical sources are derived and validated in deterministic newest-to-oldest authority order, then read and verified by exact commit, path, blob, content hash, and byte limit.
- `StageProduceInput` codecs preserve the exact decoded request and canonical hashes for replay without tracker, latest-path, or technical-repository rediscovery.
- Exact ticket rows are reloaded and hash-verified before bounded task construction, with the Ticket first in the typed authority manifest.
- Document stages return bounded `Document` output while Implementation returns a typed `ImplementationStep` prepared-commit value.
- Pure currentness comparisons and typed diagnostics are available to downstream lifecycle owners, but this work adds no ready-state, claim, task-exposure, stale-state, publication, execution, review, gate, Provenance, or aggregate-capacity lifecycle.

## Implementation Overview

- [ ] Phase 1: Replayable Exact Questions Contract
- [ ] Phase 2: Immutable Research Source Slice
- [ ] Phase 3: Specialized Document Contracts
- [ ] Phase 4: Implementation Contract and Complete Registration

---

## Phase 1: Replayable Exact Questions Contract

Replace the placeholder Questions shape with the smallest complete exact-contract path. A bounded Questions request will carry exact scope and ticket-revision identity, traverse erased catalog assembly, encode and decode as a versioned `StageProduceInput`, reload the existing content-addressed ticket row, build a bounded Ticket-first task authority manifest, and validate a tagged document result.

### File Changes

- **`src/qrspi/contracts/common.ts`**: Add Schema-backed shared bounds and identities for ticket references, exact stage scope, repository targets, source-set identity, task authority, execution context, prepared outputs, and the versioned `StageProduceInput`; add canonical encode/decode helpers that verify the nested request and source-set hashes without persisting or transitioning work.
- **`src/qrspi/contracts/questions.ts`**: Define the literal-tagged bounded `QuestionsRequest` and `QuestionsResult`, fixed compatibility rules and task instructions, empty accepted-technical-source assembly, Ticket-first authority manifest, and document projection.
- **`src/qrspi/contracts/index.ts`**: Export the shared contract types and Questions registration through one stable contract-module entry point.
- **`src/qrspi/domain.ts`**: Extract the existing ticket-revision semantic identity calculation so WorkflowStart and exact replay reads use the same canonical rule; reuse existing WorkflowId, Generation, hash, repository, and stage-definition Schemas rather than adding parallel string types.
- **`src/qrspi/stage-catalog.ts`**: Replace unknown source/context/prepared-output aliases with the shared typed models; retain executable closures in private runtime registrations; add erased request assembly, task construction, and result preparation operations that select one exact trusted registration, apply its Schema and encoded-byte limit, and prevent unselected closures or undecoded values from escaping.
- **`src/qrspi/store.ts`**: Add an exact read for `(workflowId, ticketRevisionSha256)` over the existing `qrspi_ticket_revisions` row, decode and recompute its semantic identity, and return bounded `missing`, `malformed`, `hash_mismatch`, or `identity_mismatch` data errors. Do not create or update a `StageProduce` operation.
- **`test/qrspi/contracts.test.ts`**: Cover Questions request/result tags, empty source-set identity, exact and over-limit UTF-8 values, bounded deterministic task rendering, Ticket-first authority, and rejection of mistagged or malformed results through the production erased catalog seam.
- **`test/qrspi/stage-replay.test.ts`**: Use file SQLite to round-trip a valid Questions `StageProduceInput` and exact ticket row, then corrupt the outer input, nested request, source-set hash, workflow scope, and ticket row independently and assert the exact typed failure with no task return.
- **`test/qrspi/stage-catalog.test.ts`**: Update catalog fixtures for the typed shared inputs and assert lookalike, wrong-ref, wrong-hash, wrong-Schema, and unselected-closure rejection on erased operations.
- **`test/qrspi/workflow-start.test.ts`**: Reuse the extracted ticket identity helper and extend fake ports for the new exact read surface without changing current placeholder child creation.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/contracts.test.ts test/qrspi/stage-catalog.test.ts test/qrspi/stage-replay.test.ts test/qrspi/workflow-start.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

#### Manual Verification

No manual verification is required; Schema boundaries, hash corruption, exact ticket lookup, and task-return containment are deterministic automated checks.

---

## Phase 2: Immutable Research Source Slice

Add the first technical-predecessor path end to end. Research will derive its required Questions predecessor from trusted snapshots and accepted pointers, reject wrong authority before any read, read the exact immutable artifact through the repository adapter, verify observed bytes and identities, assemble the bounded request, and replay from stored technical content without a second repository read.

### File Changes

- **`src/qrspi/contracts/common.ts`**: Add bounded `ArtifactReference`, `ExactArtifactSource`, revision-intent, accepted-pointer expectation, and exact source-envelope Schemas; define stable source role/index diagnostics and pure expected-versus-actual currentness comparison results for Generation, snapshots, run/revision, target parent, and ordered pointers.
- **`src/qrspi/contracts/research.ts`**: Define tagged bounded Research request/result Schemas, the allowed Questions predecessor subsequence, fixed task construction, and document projection.
- **`src/qrspi/contracts/index.ts`**: Export Research and the expanded shared exact-source interfaces.
- **`src/qrspi/ports.ts`**: Add a read-only exact artifact operation keyed by stable repository identity, commit SHA, repository-relative path, and byte ceiling, returning the observed commit/path/blob and exact bytes through typed repository errors.
- **`src/qrspi/adapters.ts`**: Extend the GitHub client boundary and `GitHubQrspiRepository` with bounded exact artifact reads; decode external responses, enforce the cap before returning content, and follow the existing request-observe-compare style without adding Git mutation authority.
- **`src/qrspi/source-assembly.ts`**: Derive expected predecessor membership and newest-to-oldest role order from normalized executable snapshots and accepted pointers; reject missing, extra, duplicate, reordered, wrong-repository, wrong-workflow, wrong-Generation, wrong-role/stage, wrong-accepted-revision, or wrong-final-artifact references before repository reads; then verify observed commit/path/blob, UTF-8 bytes, content SHA-256, and canonical ordered `sourceSetSha256`.
- **`src/qrspi/stage-catalog.ts`**: Route verified Research sources through the selected registration and enforce both the contract request ceiling and configured stage input ceiling on the complete encoded request.
- **`test/qrspi/source-assembly.test.ts`**: Cover the valid Research source path, disabled/absent predecessor handling, missing/extra/duplicate/reordered roles, every cross-scope mismatch with zero repository calls, stable repository identity across a full-name rename, exact byte limits, and commit/path/blob/content mismatches.
- **`test/qrspi/adapters.test.ts`**: Cover exact GitHub artifact request parameters, bounded reads, malformed external responses, timeout/error mapping, and observed identity mismatch.
- **`test/qrspi/contracts.test.ts`**: Traverse Research assemble/build/prepare through the erased catalog and prove replay uses persisted source content rather than a repository reread.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/source-assembly.test.ts test/qrspi/adapters.test.ts test/qrspi/contracts.test.ts test/qrspi/stage-catalog.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

#### Manual Verification

No manual verification is required; injected repository observations prove the external read contract and pre-read containment deterministically.

---

## Phase 3: Specialized Document Contracts

Extend the verified source and replay path to Design, Structure, and Plan while preserving their distinct authority. Each contract will accept only its trusted predecessor subsequence, Design will pin its three policy references, Structure will bind its exact owner-issued acceptance package and graph scope outside generic artifact roles, and all three will retain separate tagged result Schemas despite sharing document projection.

### File Changes

- **`src/qrspi/contracts/design.ts`**: Add the bounded Design request/result, exact Research/Questions predecessor rules, pinned Design/promotion/Structure policy identities, contract-local compatibility, task instructions, and document projection.
- **`src/qrspi/contracts/structure.ts`**: Add the bounded Structure request/result and typed exact Design acceptance package, gate response, promotion result, and graph-reference scope fields; keep these owner-issued identities distinct from generic artifact sources and perform no gate or Provenance effect.
- **`src/qrspi/contracts/plan.ts`**: Add the bounded Plan request/result, exact Structure/Design/Research/Questions predecessor rules, fixed task instructions, and document projection.
- **`src/qrspi/contracts/common.ts`**: Add only the shared bounded policy and owner-result reference Schemas needed by these contracts, preserving stage-local fields and finite encoded maxima.
- **`src/qrspi/contracts/index.ts`**: Export the three registrations and their distinct request/result Schemas.
- **`src/qrspi/stage-catalog.ts`**: Apply each built-in's fixed stage key, specialized-policy presence/absence, media/output policy, and contract-local compatibility closure during both fresh definition validation and restart preflight.
- **`src/qrspi/source-assembly.ts`**: Generalize predecessor derivation across Design, Structure, and Plan while preserving enabled-stage subsequences and newest-to-oldest authority order.
- **`test/qrspi/contracts.test.ts`**: Cover the three distinct request/result tags, specialized identity fields, bounded document maxima, invalid policy/package/graph shapes, correct document projection, and selected-closure-only execution.
- **`test/qrspi/source-assembly.test.ts`**: Cover all valid enabled/disabled predecessor subsequences through Plan and reject stage-role substitutions, accepted-revision substitutions, and order changes before task construction.
- **`test/qrspi/stage-catalog.test.ts`**: Cover fresh and persisted compatibility for required, forbidden, changed, or missing specialized policies and exact registration-hash restoration.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/contracts.test.ts test/qrspi/source-assembly.test.ts test/qrspi/stage-catalog.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

#### Manual Verification

No manual verification is required; contract-local policy and owner-result identities are fully Schema- and compatibility-testable.

---

## Phase 4: Implementation Contract and Complete Registration

Complete the family with the non-document Implementation contract, then make all six registrations the explicit live default. The final slice proves deterministic order, distinct implementation prepared output, registration-only extension through every erased operation, full restart compatibility, and per-record limits without changing any lifecycle owner.

### File Changes

- **`src/qrspi/contracts/implementation.ts`**: Define the bounded Implementation request with checkpoint position and expected parent, plus the tagged non-final/final prepared-commit result union with candidate commit, expected parent, bounded changed paths, finality, and optional final scenario evidence; project only to typed `ImplementationStep`.
- **`src/qrspi/contracts/common.ts`**: Add bounded prepared-commit, changed-path, and final-evidence Schemas and ensure the complete largest valid request stays within `MAX_STAGE_REQUEST_BYTES`.
- **`src/qrspi/contracts/index.ts`**: Export the explicit readonly built-in tuple in Questions, Research, Design, Structure, Plan, Implementation order.
- **`src/qrspi/stage-catalog.ts`**: Remove the placeholder Questions registration, finalize erased result decoding and prepared-output validation for both output tags, and preserve exact registration reference/hash selection across runtime and restart.
- **`src/layers.ts`**: Use the explicit six-contract tuple as `makeLiveLayer`'s default while preserving caller-supplied registration extension and duplicate rejection.
- **`test/qrspi/contracts.test.ts`**: Cover non-final and final Implementation results, changed-path and evidence bounds, wrong document/implementation result substitution, exact prepared output, and maximum complete request sizing.
- **`test/qrspi/stage-catalog.test.ts`**: Assert exact six-contract order and hashes, then add a seventh test-only contract and traverse production erased assemble/build/prepare operations without changing catalog, runner, queue, store, or stage-kind dispatch; verify only the selected closures run.
- **`test/layers.test.ts`**: Prove the six built-ins compose by default, missing or changed active registrations close preflight, exact restoration succeeds without changing persisted snapshots, and caller extension remains registration-only.
- **`test/qrspi/stage-replay.test.ts`**: Cover all six request codecs, hash-valid one-field wrong-scope currentness fixtures, exact task reconstruction after service/database restart, no tracker or technical-repository reads during replay, and distinct document versus implementation prepared outputs.
- **`test/qrspi/workflow-start.test.ts`**: Update catalog and repository fixtures for the complete built-in set while preserving existing WorkflowStart child-operation behavior and ownership boundaries.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/contracts.test.ts test/qrspi/stage-catalog.test.ts test/qrspi/stage-replay.test.ts test/layers.test.ts test/qrspi/workflow-start.test.ts`
- [ ] `bun test test/qrspi/source-assembly.test.ts test/qrspi/adapters.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

#### Manual Verification

No manual verification is required; live composition, restart restoration, registration-only extension, and output-kind separation are covered at their lowest deterministic boundaries.

---

## Open Questions

None. Design revision 4 and its accepted boundary review fix the ticket/reference size conflict, define exact source authority and replay identity, and assign all ready-state, claim, task-exposure, stale-state, and transition-race effects to downstream Beads.
