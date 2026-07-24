---
task: workflowd-vs3.4.2-implement-six-exact-typed-stage-contracts
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-vs3.4.2
sha: 04030d93cc9bd7ad6864a898ea1b1183acacebe6
---

# Implement Six Exact Typed Stage Contracts Implementation Plan

## Overview

Implement CAP-D2 as the four accepted vertical slices in `04-structure-outline-exact-stage-contracts.md`: first make Questions exact and replayable, then add immutable Research source assembly, then add the specialized document contracts, and finally add the distinct Implementation contract and complete live registration tuple.

Every production behavior below follows strict test-driven development. For each numbered behavior, write the smallest focused test first, run the listed focused command, and observe the stated feature-missing failure before editing production code. Then add only enough production code for GREEN, rerun the focused test and affected regression tests, refactor only while green, and rerun the same checks. If a new test passes before production code changes, revise the test until it fails for the intended missing behavior; a compile error caused solely by the wished-for API is an acceptable initial RED, but rerun after adding the smallest declaration until the test reaches a behavioral failure before implementing the behavior.

## Current State Analysis

The trusted catalog and durable WorkflowStart foundation exist, but the executable stage seam stops short of exact contracts and replay:

- `src/qrspi/stage-catalog.ts:21-32` still exposes unknown-valued source/context types and an `AgentTask` with no authority manifest.
- `src/qrspi/stage-catalog.ts:84-90` retains only descriptors, Schemas, and compatibility; the executable closures are checked during registration but are not retained for erased runtime dispatch.
- `src/qrspi/stage-catalog.ts:216-258` exposes only descriptor and compatibility operations.
- `src/qrspi/stage-catalog.ts:646-670` contains the sole built-in, broad Questions placeholder.
- `src/qrspi/domain.ts:95-102,491-607` stores a full `TicketRevision`, but its semantic hash calculation is embedded in `checkTicket` rather than reusable by replay validation.
- `src/qrspi/store.ts:176-262,619-641` writes ticket revisions under `(workflow_id, ticket_revision_sha256)` but has no exact reader.
- `src/qrspi/store.ts:1215-1237` deliberately creates historical placeholder `StageProduce` input. This plan must not convert that creation path to the new format.
- `src/qrspi/ports.ts:37-66` and `src/qrspi/adapters.ts:148-405` have repository inspection and mutation operations but no bounded exact artifact read.
- `src/qrspi/domain.ts:339-440` and `src/qrspi/stage-catalog.ts:262-439` already preserve stage order and validate fresh and persisted snapshots.
- `src/agent-payload.ts:3-18` already defines the 32 KiB request and 4 MiB result envelopes using encoded UTF-8 JSON size.
- `src/store/migrations.ts:397-408,423-483,502-526` already provides the ticket revision, generic operation, and Generation persistence required by CAP-D2. No migration or new lifecycle table is needed.

### Key Discoveries

- Registration identity already includes metadata and generated request/result JSON Schemas (`src/qrspi/stage-catalog.ts:111-175`), so finite Schema constants and metadata limits naturally alter the registration hash.
- Exact object identity already protects `registrationFor` from lookalikes (`src/qrspi/stage-catalog.ts:197-214`); erased operations should reuse the private retained registration rather than expose closures.
- Canonical hashing preserves array order while normalizing object keys and strings (`src/qrspi/domain.ts:659-721`), which is the required source-set and nested-request identity rule.
- Existing durable corruption tests mutate SQLite only to create unreachable poison states and then invoke production decoders (`test/qrspi/workflow-start.test.ts:1465-1521,2202-2281`). The new replay suite should follow that pattern.
- Repository authority uses stable provider-instance and repository IDs; `repositoryFullName` is a locator and may change (`src/qrspi/workflow-start.ts:889-895`, `test/qrspi/workflow-start.test.ts:1523-1550`).
- Effect 3.22 patterns in this repository keep expected failures in typed error channels, decode external/database values with `Schema`, and use `Effect.tryPromise` plus timeout mapping for repository calls (`src/qrspi/adapters.ts:315-330`).

## Desired End State

- Six separately exported, stage-tagged, finite request/result Schemas and contracts exist for Questions, Research, Design, Structure, Plan, and Implementation.
- `TrustedStageCatalog` is the sole heterogeneous dispatch seam for assemble, build-task, and prepare-output operations. It selects one retained registration by exact reference, decodes with that registration's Schemas, enforces encoded bounds, invokes only that registration's closure, and returns only decoded task/prepared values.
- Exact request identity includes Workflow, Generation, stage run/revision, workflow/stage definition hashes, bounded ticket revision reference, ordered accepted technical source references and content, source-set hash, repository target, and optional revision intent.
- Technical source membership/order derives from trusted snapshots and accepted pointers. Wrong authority fails before I/O; exact commit/path/blob/content observations and UTF-8 bounds fail before a request is returned.
- A versioned `StageProduceInput` codec verifies outer input, nested request, and ordered source-set hashes. Replay loads and rehashes only the exact immutable ticket row and never rereads tracker or technical repository state.
- The task authority manifest places the ticket reference first and retains technical source order without putting the full ticket into the bounded prompt or request.
- Questions through Plan produce distinct bounded document result tags and project to `Document`; Implementation uses a bounded prepared-commit union and projects only to `ImplementationStep`.
- The default live catalog uses the explicit Questions, Research, Design, Structure, Plan, Implementation tuple. A seventh test registration traverses the production erased seam without a central stage switch.
- `bun run check` passes, including complete Effect diagnostics, formatting, lint, and coverage.

## What We're NOT Doing

- Do not add or change StageRun, StageRevision, document revision, implementation step/checkpoint, ready-state, claim, lease, stale/superseded, quarantine, custody, or progression persistence.
- Do not change `completeStart` to create a new-format claimable `StageProduce`; its current placeholder children remain historical and are only fenced by the new codec not accepting their shape.
- Do not add SQLite tables, columns, migrations, triggers, or aggregate storage/capacity guarantees.
- Do not execute agents, materialize workspaces, publish Git state, implement reviews/gates/Provenance, execute Plan/Implementation stages, or load executable code/Schemas/prompts from repositories.
- Do not add mutable latest-path, branch-relative, tracker reread, or technical repository reread behavior to replay.
- Do not implement downstream CAP-D3/D4/D7 atomic persistence, claim, task-exposure, stale-state effects, or transition-race tests. CAP-D2 supplies only pure expectations/comparisons and typed diagnostics for those owners.
- Do not turn the existing ticket source readiness resolver into the immutable artifact reader; the exact read belongs on `QrspiRepositoryPort`.

## Implementation Approach

Keep concrete request/result types in contract modules under `src/qrspi/contracts/`, shared finite identity types in `contracts/common.ts`, and all heterogeneous erasure inside `TrustedStageCatalog`. Keep source authority and external reads in `source-assembly.ts`, and keep durable row reading in `QrspiStore`. Use the existing canonical hash function rather than another serializer. Add no generic orchestrator switch.

Each phase is independently testable and pauses before the next phase. Within each phase, preserve the RED -> observed expected failure -> GREEN minimal implementation -> REFACTOR/reverification order for every production behavior.

---

## Phase 1: Replayable Exact Questions Contract

### Overview

Create the smallest complete exact path: shared bounded identity/codecs, reusable ticket semantic identity, exact ticket-row reading, Questions request/result behavior, and catalog-contained erased assemble/build/prepare operations. Questions has no technical predecessor, so this phase proves empty source identity and replay without repository work.

### Changes Required

#### 1.1 RED: Reusable ticket revision semantic identity

**Files**: `test/qrspi/ticket.test.ts`, `src/qrspi/domain.ts`

**Behavior**: A pure exported helper recomputes the same semantic ticket revision hash that `checkTicket` creates, excluding `checkedAt` and tracker observation metadata. It accepts the Schema-decoded product fields and scenario coverage, so exact replay can verify a stored row without invoking readiness or a tracker.

1. Add a focused test that obtains a Ready result, calls the wished-for `ticketRevisionSha256For(readyTicket, scenarioCoverage)`, and expects equality with `ticketRevision.ticketRevisionSha256`; also prove changed product content changes the hash while changed `checkedAt`/`sourceRevision` does not.
2. Run `bun test test/qrspi/ticket.test.ts` and observe RED because the helper is absent (then, after adding only its signature/export if needed, because replayed semantic identity is not computed through a shared function).
3. GREEN: extract the existing canonical product envelope from `checkTicket` without changing its hash format, and have both `checkTicket` and the test call the helper.

```ts
export function ticketRevisionSha256For(
  readyTicket: ReadyTicket,
  scenarioCoverage: ReadonlyArray<ReadonlyArray<number>>,
): string {
  return canonicalSha256({
    contractVersion: 1,
    normalizationVersion: "RFC8785-NFC-1",
    product: {
      issueType: readyTicket.issueType,
      title: readyTicket.title,
      ...(readyTicket.userStory === undefined ? {} : { userStory: readyTicket.userStory }),
      description: readyTicket.description,
      sources: readyTicket.sources,
      ...(readyTicket.outOfScope === undefined ? {} : { outOfScope: readyTicket.outOfScope }),
      acceptanceCriteria: readyTicket.acceptanceCriteria,
      scenarios: readyTicket.scenarios,
    },
    scenarioCoverage,
  })
}
```

4. REFACTOR: remove the duplicated inline hash envelope from `checkTicket`, retain its existing output, and rerun `bun test test/qrspi/ticket.test.ts` plus `bun run typecheck`.

#### 1.2 RED: Shared exact identity, authority, prepared-output, and replay Schemas

**Files**: `test/qrspi/contracts.test.ts` (new), `src/qrspi/contracts/common.ts` (new), `src/qrspi/contracts/index.ts` (new)

**Behavior**: Shared Schemas define finite ticket reference, stage scope, repository target, empty/ordered source identity, typed task authority, execution context, prepared output, and a versioned new-format `StageProduceInput`. Encoding computes `requestSha256`; decoding rejects malformed data and independently recomputes the nested request and ordered source-set hashes. Placeholder child input is not accepted.

1. Add tests for Schema-valid exact scope, empty ordered source-set hash, new-format encode/decode round trip, nested request mutation, source-set hash mutation, and rejection of the current `{ stageKey, stageKind, stageRevision, workflowDefinitionSha256 }` placeholder.
2. Run `bun test test/qrspi/contracts.test.ts` and observe RED because the shared Schemas/codecs do not exist.
3. GREEN: add finite reusable primitives by exporting or reusing the existing domain Schemas rather than parallel string aliases. `StageProduceInput` should retain the decoded request as JSON-domain unknown only at the erased durable wrapper, with validation delegated to the selected catalog registration.

```ts
export const TicketRevisionReference = Schema.Struct({
  workflowId: WorkflowId,
  ticketRevisionSha256: Sha256,
})

export const StageProduceInput = Schema.Struct({
  contractVersion: Schema.Literal(1),
  scope: ExactStageScope,
  contract: StageContractRef,
  request: Schema.Unknown,
  requestSha256: Sha256,
})

export const encodeStageProduceInput = (scope, contract, decodedRequest) => ({
  contractVersion: 1 as const,
  scope,
  contract,
  request: decodedRequest,
  requestSha256: canonicalSha256(decodedRequest),
})
```

`ExactStageSources` must include `sourceSetSha256` even when `sources` is empty; hash the ordered `{ role, artifact }[]`, not source content or an object map. Define prepared output as a finite tagged Schema, including a bounded document text field, instead of leaving it as TypeScript-only aliases.

4. REFACTOR: centralize only genuinely shared bounds and branded domain Schemas, keep stage-local tags/fields out of `common.ts`, and rerun `bun test test/qrspi/contracts.test.ts` and `bun run effect:check`.

#### 1.3 RED: Exact immutable ticket-row read

**Files**: `test/qrspi/stage-replay.test.ts` (new), `src/qrspi/store.ts`

**Behavior**: `QrspiStorePort.readTicketRevision` selects exactly `(workflowId, ticketRevisionSha256)`, Schema-decodes `revision_json`, recomputes semantic identity with `ticketRevisionSha256For`, and classifies missing, malformed, hash-mismatched, and cross-workflow/hash identity failures. It does not mutate or quarantine any row in CAP-D2.

1. Build a file-SQLite test using `QrspiStoreLive`, seed a workflow and valid ticket revision through the existing WorkflowStart/store path or minimal valid SQL, and assert exact round trip.
2. Add one mutation at a time for a missing row, malformed-but-SQL-valid object, stored key versus nested hash mismatch, changed semantic ticket content with unchanged hash, and wrong workflow lookup.
3. Run `bun test test/qrspi/stage-replay.test.ts` and observe RED because `readTicketRevision` is absent.
4. GREEN: add the narrow port method and row Schema. Use `QrspiStoreDataError` with `record: "ticket_revision"` (extend the record union), the existing stable reasons, expected/actual hashes where relevant, and no state update.

```ts
readonly readTicketRevision: (input: {
  readonly workflowId: string
  readonly ticketRevisionSha256: string
}) => Effect.Effect<TicketRevision, SqlError | QrspiStoreDataError>
```

```sql
SELECT workflow_id, ticket_revision_sha256, revision_json
FROM qrspi_ticket_revisions
WHERE workflow_id = ? AND ticket_revision_sha256 = ?
```

5. REFACTOR: share bounded `dataError` construction with existing durable readers without routing read-only ticket failures through the workflow-operation quarantine helper. Rerun `bun test test/qrspi/stage-replay.test.ts test/qrspi/workflow-start.test.ts`.

#### 1.4 RED: Exact Questions contract and erased catalog execution

**Files**: `test/qrspi/contracts.test.ts`, `test/qrspi/stage-catalog.test.ts`, `src/qrspi/contracts/questions.ts` (new), `src/qrspi/contracts/index.ts`, `src/qrspi/stage-catalog.ts`

**Behavior**: Questions owns literal-tagged bounded request/result Schemas, accepts no technical sources, builds a deterministic bounded task with a Ticket-first authority manifest, and projects only a decoded Questions result to `Document`. Catalog operations retain and invoke executable closures privately and reject wrong refs, lookalikes, wrong request/result tags, configured-input overflow, and unselected closure execution.

1. Add `contracts.test.ts` cases that traverse the wished-for production erased methods rather than calling concrete methods directly: assemble empty Questions sources, encode/decode `StageProduceInput`, build a task from a verified ticket revision, and prepare a document result.
2. Update the test catalog fixtures with typed shared sources/context/authority and closure counters. Add tests proving only the selected registration's closure runs for each erased operation.
3. Add boundary tests for an exact maximum request/result and one encoded UTF-8 byte over, using `Buffer.byteLength(JSON.stringify(value), "utf8")` rather than string length.
4. Run `bun test test/qrspi/contracts.test.ts test/qrspi/stage-catalog.test.ts` and observe RED because the erased methods and exact Questions Schemas are absent; malformed/mistagged values currently cannot be rejected through that seam.
5. GREEN: retain executable closures in `RuntimeRegistration`, add typed error operations such as `assembleRequest`, `buildTask`, and `prepareOutput` to `StageCatalogPort`, and always resolve the private registration by exact decoded reference.

```ts
type RuntimeRegistration = {
  readonly source: StageContractRegistration
  readonly descriptor: StageContractDescriptor
  readonly requestSchema: Schema.Schema.Any
  readonly resultSchema: Schema.Schema.Any
  readonly compatibility: (definition: StageDefinition) => void
  readonly assembleRequest: (sources: ExactStageSources) => unknown
  readonly buildTask: (request: unknown) => AgentTask<unknown, unknown>
  readonly prepareOutput: (result: unknown, context: StageExecutionContext) => unknown
}
```

The erased flow must be ordered as follows:

```text
select exact private registration
  -> invoke only its assemble closure
  -> decode with its request Schema
  -> enforce contract and configured encoded request bounds
  -> encode request hash

decode StageProduceInput and verify outer/nested/source hashes
  -> require exact contract ref
  -> verify supplied exact TicketRevision matches request reference
  -> invoke only selected buildTask closure
  -> decode/bound title, prompt, authority, and selected result Schema metadata

select exact registration
  -> apply global and contract result envelopes
  -> decode selected result Schema
  -> invoke only selected prepareOutput closure
  -> decode PreparedStageOutput Schema
```

6. Move the built-in to `contracts/questions.ts`, with a distinct request tag and result tag:

```ts
export const QuestionsRequest = Schema.Struct({
  _tag: Schema.Literal("QuestionsRequest"),
  sources: ExactStageSources,
})

export const QuestionsResult = Schema.Struct({
  _tag: Schema.Literal("Questions"),
  document: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
})
```

The task prompt must contain fixed Questions instructions, not the full ticket or source content. `authority` carries the verified ticket reference first and an empty source list.

7. REFACTOR: delete the placeholder exports from `stage-catalog.ts`, re-export stable public contract symbols from `contracts/index.ts`, keep no stage-key branch in the catalog, and rerun the focused tests plus `bun run typecheck` and `bun run effect:check`.

#### 1.5 RED: Existing callers compile without changing lifecycle ownership

**Files**: `test/qrspi/workflow-start.test.ts`, `src/qrspi/workflow-start.ts` only if imports/types require it

**Behavior**: Existing WorkflowStart tests use the extracted ticket hash helper and expanded fake repository/store ports, while current initial child operation creation remains unchanged.

1. Add an assertion in the existing snapshot test that the WorkflowStart-created `StageProduce` input remains the old placeholder and is rejected by `StageProduceInput`; this records the explicit new-format fence without implementing conversion.
2. Run `bun test test/qrspi/workflow-start.test.ts` and observe RED because the new codec/fence assertion or expanded port fixture is not yet wired.
3. GREEN: update fixtures and imports only; do not call contract assembly from `completeStart` and do not alter `src/qrspi/store.ts:1199-1237` child creation.
4. REFACTOR/reverify with `bun test test/qrspi/workflow-start.test.ts test/qrspi/stage-replay.test.ts`.

### Success Criteria

#### Automated Verification

- [ ] Every Phase 1 behavior has a focused test committed to RED first, and the implementer records the expected feature-missing failure before its production change.
- [ ] `bun test test/qrspi/ticket.test.ts test/qrspi/contracts.test.ts test/qrspi/stage-catalog.test.ts test/qrspi/stage-replay.test.ts test/qrspi/workflow-start.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

No manual verification is required; Schema, hash, exact-row, closure-selection, and no-task-on-failure behavior is deterministic.

**Implementation Note**: After completing Phase 1 and all automated verification passes, pause for human confirmation before proceeding to Phase 2.

---

## Phase 2: Immutable Research Source Slice

### Overview

Add the first technical predecessor end to end. Research derives Questions authority from trusted snapshots and accepted pointers, rejects wrong authority before I/O, performs one bounded exact repository read, verifies immutable observations and bytes, and persists technical content in the request so replay performs no repository reread.

### Changes Required

#### 2.1 RED: Exact artifact and accepted-pointer Schemas plus pure currentness diagnostics

**Files**: `test/qrspi/source-assembly.test.ts` (new), `src/qrspi/contracts/common.ts`

**Behavior**: Finite Schemas represent `ArtifactReference`, `ExactArtifactSource`, accepted predecessor expectations, revision intent, and currentness expected/actual values. Pure comparison returns a typed mismatch with exact expected/actual data for Generation, snapshot, run ordinal, stage revision, target parent, contract identity, and ordered pointer identity; it performs no state effect.

1. Add focused Schema tests for exact artifact identity and a table of one-field currentness changes whose canonical hashes are recomputed, proving hash-valid wrong-scope inputs still fail semantically.
2. Run `bun test test/qrspi/source-assembly.test.ts` and observe RED because these Schemas/comparisons are absent.
3. GREEN: add finite role, path, media type, Git SHA, blob SHA, content SHA-256, run/revision, pointer, and revision-intent fields. Reuse `RepositoryReference`, workflow/stage hashes, and stable IDs.

```ts
export const ArtifactReference = Schema.Struct({
  repository: RepositoryReference,
  workflowId: WorkflowId,
  generation: Generation,
  stageKey: StageKey,
  stageRevision: PositiveVersion,
  commitSha: GitSha,
  path: RepositoryRelativePath,
  blobSha: GitSha,
  contentSha256: Sha256,
  mediaType: BoundedMediaType,
})

export const ExactArtifactSource = Schema.Struct({
  role: StageSourceRole,
  artifact: ArtifactReference,
  content: BoundedStageSource,
})
```

4. Keep mismatch reasons stable and bounded, with optional `role`/`index` and exact expected/actual values; do not introduce stale-state mutation.
5. REFACTOR/reverify with `bun test test/qrspi/source-assembly.test.ts` and `bun run effect:check`.

#### 2.2 RED: Read an exact immutable GitHub artifact

**Files**: `test/qrspi/adapters.test.ts`, `src/qrspi/ports.ts`, `src/qrspi/adapters.ts`

**Behavior**: `QrspiRepositoryPort.readArtifact` requests one repository-relative file at an exact commit and byte ceiling, rejects directory/symlink/unsupported/malformed responses, strictly decodes returned bytes, enforces the cap before returning content, and reports requested/observed commit, path, blob SHA, and bytes through the typed repository error channel. It adds no mutation authority.

1. Extend the fake Octokit surface and add tests for exact owner/repo/path/ref parameters, exact-cap success, one-byte-over failure, malformed base64, directory response, timeout/error mapping, observed path mismatch, and blob mismatch handling at the caller boundary.
2. Run `bun test test/qrspi/adapters.test.ts` and observe RED because `readArtifact` and the content API boundary do not exist.
3. GREEN: add a typed port shape and an optional testable `repos.getContent` boundary. Decode the external response with Effect Schema before base64 decoding. Keep exact commit in both request and returned observation; return bytes, not replacement-decoded text.

```ts
readonly readArtifact: (input: {
  readonly repository: RepositoryReference
  readonly commitSha: string
  readonly path: string
  readonly maxBytes: number
}) => Effect.Effect<{
  readonly commitSha: string
  readonly path: string
  readonly blobSha: string
  readonly bytes: Uint8Array
}, QrspiRepositoryError>
```

4. Use the existing `attempt` timeout/error mapping and `repositoryName` locator. Do not compare `repositoryFullName` as stable authority in this adapter method; source assembly performs stable-ID authority checks first.
5. REFACTOR/reverify with `bun test test/qrspi/adapters.test.ts` and `bun run typecheck`.

#### 2.3 RED: Trusted predecessor derivation and exact source assembly

**Files**: `test/qrspi/source-assembly.test.ts`, `src/qrspi/source-assembly.ts` (new)

**Behavior**: For a selected Research snapshot, derive the enabled predecessor subsequence from ordered executable snapshots, require exactly one accepted Questions pointer, validate complete pointer/final-artifact authority before I/O, perform one exact artifact read, verify observation/blob/content/strict UTF-8, and return ordered `ExactStageSources` with canonical `sourceSetSha256`.

1. Add a valid Research test with Questions enabled and accepted. Assert exact output, one repository call, and the hash over the ordered reference array.
2. Add cases for disabled/absent Questions, missing/extra/duplicate/reordered pointers, wrong stable repository ID, workflow, Generation, role/stage, accepted stage revision, or any final-artifact field. Assert exact role/index reason and zero repository calls for all pre-read failures.
3. Add post-read cases for observed commit/path/blob mismatch, malformed UTF-8 (fatal `TextDecoder`), content SHA mismatch, exact byte ceiling, one byte over, and a repository full-name rename with stable provider/repository IDs.
4. Run `bun test test/qrspi/source-assembly.test.ts` and observe RED because no assembler exists and wrong authority cannot be rejected before I/O.
5. GREEN: implement the sequence directly and serially with `Effect.forEach(..., { concurrency: 1 })` so error order and authority order remain deterministic.

```text
normalize trusted snapshots
  -> locate selected stage by exact key/hash
  -> derive effectively enabled predecessors
  -> map known predecessor keys to newest-to-oldest roles
  -> compare pointer membership/order/complete identity
  -> read exact bytes only after all pre-read checks pass
  -> compare observed commit/path/blob
  -> decode UTF-8 fatally and enforce content byte bound
  -> compare content SHA-256
  -> compute sourceSetSha256 over ordered role/reference pairs
  -> Schema-decode ExactStageSources
```

6. REFACTOR: keep derivation, pre-read equality, and post-read observation checks as small pure helpers only where reused; retain one public assembly function. Rerun `bun test test/qrspi/source-assembly.test.ts` and `bun run effect:check`.

#### 2.4 RED: Research contract traverses erased assemble/build/prepare and replay

**Files**: `test/qrspi/contracts.test.ts`, `test/qrspi/stage-replay.test.ts`, `src/qrspi/contracts/research.ts` (new), `src/qrspi/contracts/index.ts`, `src/qrspi/stage-catalog.ts`

**Behavior**: Research accepts only the Questions predecessor subsequence, has distinct request/result tags, builds fixed Research instructions with Ticket-first authority, projects a Research result to `Document`, and replays from persisted source content without a second repository call.

1. Add erased-seam tests for Research's valid request, wrong role, wrong tag, task authority order, result projection, exact UTF-8 bounds, and replay after replacing the repository fake with one that fails on any call.
2. Run `bun test test/qrspi/contracts.test.ts test/qrspi/stage-replay.test.ts` and observe RED because Research is not registered and replay has no technical source.
3. GREEN: add the smallest Research module and route the already verified exact envelope through selected catalog operations. Enforce both `contract.maxRequestBytes` and the supplied configured `maxEncodedInputBytes` on the complete decoded request.
4. REFACTOR/reverify with `bun test test/qrspi/contracts.test.ts test/qrspi/stage-replay.test.ts test/qrspi/stage-catalog.test.ts`.

### Success Criteria

#### Automated Verification

- [ ] Every Phase 2 behavior has a focused RED run with the expected missing-behavior failure recorded before production changes.
- [ ] `bun test test/qrspi/source-assembly.test.ts test/qrspi/adapters.test.ts test/qrspi/contracts.test.ts test/qrspi/stage-replay.test.ts test/qrspi/stage-catalog.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

No manual verification is required; injected repository observations prove exact external-read behavior and zero-I/O containment deterministically.

**Implementation Note**: After completing Phase 2 and all automated verification passes, pause for human confirmation before proceeding to Phase 3.

---

## Phase 3: Specialized Document Contracts

### Overview

Extend the verified source/replay path to Design, Structure, and Plan. Keep each contract's request/result tag and local authority fields distinct even though all three project to `Document`.

### Changes Required

#### 3.1 RED: Design contract and contract-local compatibility

**Files**: `test/qrspi/contracts.test.ts`, `test/qrspi/stage-catalog.test.ts`, `src/qrspi/contracts/design.ts` (new), `src/qrspi/contracts/common.ts`, `src/qrspi/contracts/index.ts`

**Behavior**: Design accepts the enabled Research/Questions predecessor subsequence in that relative order, pins exact Design, promotion, and Structure policy refs in its request, requires the configured Design policies and artifact output, returns a distinct `Design` result tag, and projects a bounded document.

1. Add request/result Schema tests, valid enabled/disabled predecessor subsequences, missing/changed policy fields, fresh compatibility, persisted compatibility, and result substitution failures.
2. Run `bun test test/qrspi/contracts.test.ts test/qrspi/stage-catalog.test.ts` and observe RED because `qrspi.design@1` is absent and generic compatibility alone does not enforce Design-local invariants.
3. GREEN: add finite policy identity fields and the Design module. Its compatibility closure checks only fixed key/local policy/output invariants; leave kind, global bounds, supported policy versions, and harness checks in generic validation.
4. REFACTOR/reverify the same focused command, including restart snapshot validation.

#### 3.2 RED: Structure owner-issued authority remains distinct from artifact roles

**Files**: `test/qrspi/contracts.test.ts`, `test/qrspi/source-assembly.test.ts`, `test/qrspi/stage-catalog.test.ts`, `src/qrspi/contracts/structure.ts` (new), `src/qrspi/contracts/common.ts`, `src/qrspi/contracts/index.ts`

**Behavior**: Structure accepts the Design/Research/Questions predecessor subsequence plus a separate bounded exact field for Design acceptance package, gate response, promotion result, and graph reference/scope. These values are identities only; no gate or Provenance effect runs.

1. Add tests for valid bounded owner-result identities, missing/malformed/cross-scope identities, attempted substitution as a generic artifact role, required Structure policy compatibility, and distinct `Structure` result projection.
2. Run the focused three-suite command and observe RED because the Structure Schema/contract and owner-result field are absent.
3. GREEN: add only the finite reference fields needed by the accepted Design. Do not model owner lifecycle records or current graph state beyond the exact input references.

```ts
export const StructureAuthority = Schema.Struct({
  acceptancePackage: DesignAcceptancePackageReference,
  gateResponse: DesignGateResponseReference,
  promotionResult: ProvenancePromotionResultReference,
  graph: GraphReference,
})
```

4. REFACTOR/reverify with `bun test test/qrspi/contracts.test.ts test/qrspi/source-assembly.test.ts test/qrspi/stage-catalog.test.ts`.

#### 3.3 RED: Plan contract and generalized document predecessor assembly

**Files**: `test/qrspi/contracts.test.ts`, `test/qrspi/source-assembly.test.ts`, `test/qrspi/stage-catalog.test.ts`, `src/qrspi/contracts/plan.ts` (new), `src/qrspi/source-assembly.ts`, `src/qrspi/contracts/index.ts`

**Behavior**: Plan accepts the enabled Structure/Design/Research/Questions subsequence in newest-to-oldest order, retains distinct Plan request/result tags, and projects a bounded document. Source assembly handles all document predecessor subsequences without a stage-specific central switch.

1. Add table-driven source tests for every valid enabled/disabled subsequence through Plan and one-at-a-time stage-role, accepted-revision, and order substitutions.
2. Add erased Plan request/task/result tests and selected-closure counters.
3. Run the focused suites and observe RED because Plan is absent and source derivation handles only Research.
4. GREEN: generalize source derivation from trusted ordered snapshots plus a data mapping owned by exact source roles. Contract-local allowed-role validation remains in each contract; do not add orchestration branches for task/result behavior.
5. REFACTOR: extract a small document-contract construction helper only if it preserves separate exported Schemas, tags, compatibility closures, and instructions. Do not collapse the five result Schemas into one broad type. Rerun focused suites and `bun run typecheck`.

### Success Criteria

#### Automated Verification

- [ ] Design, Structure, and Plan each went through a separate RED/observed failure/GREEN/REFACTOR cycle.
- [ ] `bun test test/qrspi/contracts.test.ts test/qrspi/source-assembly.test.ts test/qrspi/stage-catalog.test.ts test/qrspi/stage-replay.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

No manual verification is required; all policy, owner-result, order, and projection behavior is deterministic at Schema/catalog/source boundaries.

**Implementation Note**: After completing Phase 3 and all automated verification passes, pause for human confirmation before proceeding to Phase 4.

---

## Phase 4: Implementation Contract and Complete Registration

### Overview

Add the non-document Implementation contract, complete the explicit six-contract default tuple, prove registration-only extension through every erased operation, and verify restart/fail-closed behavior and all replay/boundary guarantees.

### Changes Required

#### 4.1 RED: Distinct Implementation request/result and prepared output

**Files**: `test/qrspi/contracts.test.ts`, `test/qrspi/source-assembly.test.ts`, `src/qrspi/contracts/implementation.ts` (new), `src/qrspi/contracts/common.ts`, `src/qrspi/contracts/index.ts`

**Behavior**: Implementation accepts the enabled Plan/Structure/Design/Research/Questions subsequence, binds checkpoint position and expected parent, and returns a tagged non-final/final prepared-commit union with bounded changed paths and final scenario evidence. It projects only to `ImplementationStep`; document results cannot cross this seam.

1. Add tests for non-final and final valid results; expected-parent mismatch; changed-path count/path/byte bounds; missing or forbidden final evidence; wrong document/implementation result substitution; and exact prepared value preservation.
2. Add complete-request maximum tests using worst-case valid encoded values. Assert the largest Schema-valid request is at most `MAX_STAGE_REQUEST_BYTES` and one-byte-over source/result values fail at their lowest owned boundary.
3. Run `bun test test/qrspi/contracts.test.ts test/qrspi/source-assembly.test.ts` and observe RED because Implementation and its finite prepared-commit Schemas are absent.
4. GREEN: add finite schemas and contract-local compatibility for fixed key and `ImplementationCheckpoint` output policy.

```ts
export const ImplementationResult = Schema.Union(
  Schema.TaggedStruct("PreparedCommit", {
    candidateCommitSha: GitSha,
    expectedParentSha: GitSha,
    changedPaths: BoundedChangedPaths,
    final: Schema.Literal(false),
  }),
  Schema.TaggedStruct("PreparedFinalCommit", {
    candidateCommitSha: GitSha,
    expectedParentSha: GitSha,
    changedPaths: BoundedChangedPaths,
    final: Schema.Literal(true),
    scenarioEvidence: BoundedScenarioEvidence,
  }),
)
```

5. REFACTOR/reverify the focused suites and `bun run effect:check`.

#### 4.2 RED: Explicit six-contract tuple and complete default Layer composition

**Files**: `test/qrspi/stage-catalog.test.ts`, `test/layers.test.ts`, `src/qrspi/contracts/index.ts`, `src/qrspi/stage-catalog.ts`, `src/layers.ts`

**Behavior**: The live default is the explicit readonly tuple Questions, Research, Design, Structure, Plan, Implementation. All references/hashes resolve in that order. Missing or changed active registrations close fresh/restart preflight, exact restoration succeeds without rewriting snapshots, and caller-supplied extension/duplicate behavior remains supported.

1. Add a catalog test asserting the exact six refs in order and distinct registration hashes.
2. Add Layer tests with a complete valid six-stage definition, missing/changed registration on persisted snapshots, exact restoration, and caller extension.
3. Run `bun test test/qrspi/stage-catalog.test.ts test/layers.test.ts` and observe RED because the default contains only Questions and the complete tuple export is absent.
4. GREEN: export `builtInStageContracts` as an explicit tuple and use it as `makeLiveLayer`'s default. Preserve the explicit override parameter used by tests/deployments and constructor duplicate rejection.

```ts
export const builtInStageContracts = [
  questionsStageContract,
  researchStageContract,
  designStageContract,
  structureStageContract,
  planStageContract,
  implementationStageContract,
] as const
```

5. Remove any remaining placeholder Questions definitions from `stage-catalog.ts`; import contract registrations through `contracts/index.ts` without a circular dependency.
6. REFACTOR/reverify the two suites plus `bun run typecheck`.

#### 4.3 RED: Seventh registration traverses production erased operations

**Files**: `test/qrspi/stage-catalog.test.ts`, `src/qrspi/stage-catalog.ts` only if the test exposes a missing generic operation

**Behavior**: A seventh test-only contract registers without changing catalog, runner, store, queue, stage-kind dispatch, or any production switch, and traverses assemble/build/prepare through the public erased port. Only its closures run; lookalike/ref/hash/Schema/policy mismatches fail closed.

1. Replace the old concrete `registrationFor(...).source.buildTask/prepareOutput` extension proof at `test/qrspi/stage-catalog.test.ts:106-129` with public erased operations and per-closure counters for all seven registrations.
2. Add wrong request tag, wrong result tag, lookalike registration, wrong contract ref, changed registration hash, and incompatible policy cases.
3. Run `bun test test/qrspi/stage-catalog.test.ts` and observe RED if any erased operation still depends on built-in assumptions or permits an unselected closure/value to escape.
4. GREEN: make only the minimal generic catalog correction. Do not add a seventh production contract or stage switch.
5. REFACTOR/reverify `bun test test/qrspi/stage-catalog.test.ts` and `bun run effect:check`.

#### 4.4 RED: Complete six-contract replay and no mutable rediscovery

**Files**: `test/qrspi/stage-replay.test.ts`, `test/qrspi/workflow-start.test.ts`

**Behavior**: All six request codecs round trip and rebuild identical task authority after service/database restart. Corrupt outer input, nested request, source-set, ticket row, wrong-scope-but-rehashed authority, and result tags return exact typed errors with no tracker or technical repository read and no task/prepared output. Corrected ticket content creates a distinct existing WorkflowStart/Generation identity rather than changing old work.

1. Add table-driven valid round trips for all six contracts and compare request hash, task title/prompt, Ticket-first authority, ordered sources, and prepared output before/after reconstructing Layers over the same file database.
2. Add tracker/repository call counters fixed at zero during replay.
3. Mutate one field at a time, recompute all enclosing hashes for wrong-scope fixtures, and expect semantic `identity_mismatch`/currentness diagnostics rather than accepting hash validity as authority.
4. Run `bun test test/qrspi/stage-replay.test.ts test/qrspi/workflow-start.test.ts` and observe RED because complete contract replay and wrong-scope diagnostics are not yet covered.
5. GREEN: correct only codec/comparison/read behavior. Do not add ready persistence, claims, task exposure, quarantine, or race transitions.
6. REFACTOR/reverify focused suites and ensure the existing WorkflowStart successor-generation and placeholder child assertions remain unchanged.

#### 4.5 Final refactor and full verification

**Files**: all files changed in Phases 1-4

1. Run the focused contract/source/catalog/replay/adapter/Layer/WorkflowStart suites while all tests are green.
2. Remove duplicated finite Schema fragments, stale placeholder exports/imports, and test-only production helpers. Keep one public function per reusable behavior and avoid broad abstraction across stage-local semantics.
3. Run `bun run typecheck`, then `bun run effect:check`; fix production types rather than weakening tests or asserting unknown external/database values.
4. Run `bun run check`. Treat incomplete Effect diagnostics, warnings, formatting differences, or coverage regressions as failures.
5. Re-run the focused suites after any refactor or check-driven edit.

### Success Criteria

#### Automated Verification

- [ ] Every Phase 4 production behavior has an observed focused RED before implementation and a focused GREEN plus post-refactor reverification.
- [ ] `bun test test/qrspi/contracts.test.ts test/qrspi/source-assembly.test.ts test/qrspi/stage-catalog.test.ts test/qrspi/stage-replay.test.ts`
- [ ] `bun test test/qrspi/adapters.test.ts test/layers.test.ts test/qrspi/workflow-start.test.ts test/qrspi/ticket.test.ts`
- [ ] `bun test test/agent-harness.test.ts test/opencode/structured-session.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`
- [ ] Exact built-in order is Questions, Research, Design, Structure, Plan, Implementation.
- [ ] The seventh test contract traverses public erased assemble/build/prepare operations with no central dispatch change.
- [ ] Exact UTF-8 maxima pass and one-byte-over cases fail at repository/source/request/result boundaries.
- [ ] Pre-read authority failures make zero repository calls; replay makes zero tracker and technical repository calls.
- [ ] Invalid or corrupt requests/results return no task or prepared output.
- [ ] No migration, lifecycle transition, agent execution, publication, gate, Provenance mutation, or aggregate-capacity behavior was added.

No manual verification is required; live composition, restart restoration, source observations, extension, replay, and output-kind separation all have deterministic automated boundaries.

**Implementation Note**: After completing Phase 4 and all automated verification passes, pause for human confirmation before treating the implementation plan as complete.
