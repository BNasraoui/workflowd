# Post-Structure Scope Review: Diagnose Document Aggregate Order and Hash Contradictions

## Verdict

`FeatureFit`

**Plan readiness: blocked pending authority clarification and Structure revision.** The executable
trusted-reader slice is one reviewable feature, but the bead still requires reader behavior for
states that migration `0011` makes unrepresentable and an artifact hash contradiction for which the
accepted aggregate has no comparison authority. A Plan may proceed only after the exact edits below
are accepted. This is not a research, feasibility, split, or epic-sizing block.

## Estimate

```yaml
estimatedChangedLines:
  low: 220
  likely: 350
  high: 500
confidence: medium
decision: FeatureFit
planMayProceed: false
```

| Human-authored executable surface | Low | Likely | High |
| --- | ---: | ---: | ---: |
| `src/qrspi/store.ts`: source-array duplicate/reorder classification, source-set hash selection/orientation, and prepared-result hash orientation | 65 | 100 | 145 |
| `test/qrspi/store.test.ts`: isolated source duplicate, source reorder, stored source hash, and stored prepared hash cases, reusing the valid deterministic-order control | 155 | 250 | 355 |
| **Total** | **220** | **350** | **500** |

The estimate counts additions and substantive edits only. Migration, contract, domain, configuration,
documentation, generated, lockfile, formatting-only, `.1.8` containment, and QRSPI artifact work are
zero. Existing SQL evidence is reused rather than changed or repeated. The subtotals reconcile
exactly to the accepted T4b allocation, and the high estimate remains below the 1,000-line admission
trigger.

## Evidence

- The accepted Design places local shape, keys, and uniqueness in strict SQLite and semantic
  ordering/hash checks in Effect Schemas and store methods. It does not authorize defeating SQL keys
  to make corruption fixtures, adding artifact bytes, or importing CAP-D5 publication behavior.
- Migration `0011` stores `source_set_json` as one JSON array and `source_set_sha256` as one digest.
  There is no source child table or source ordinal. Array position is the only durable order.
- `ExactStageSources` independently supplies the trusted producer projection and validates
  `sourceSetSha256` as the canonical hash of its ordered `{ role, artifact }` projection. That gives
  the reader two values to compare: trusted producer authority and the stored projection/row hash.
- The document payload and artifact tables each use the complete revision identity as their primary
  key. The document ownership primary key adds `operation_role`, and `operation_id` is unique. The
  common owner is primary-keyed by `operation_id`. Migration metadata tests inspect these exact
  indexes, while direct-SQL tests already reject second `produce`/`publish` owners and operation reuse.
- The final artifact is absent or one `ArtifactReference`. Its durable row has `commit_sha`,
  `blob_sha`, and `content_sha256`, but no content bytes, independently derived content digest, or
  hash of the complete reference. The accepted `.1.5` artifacts expressly require strict decoding
  and preservation, not recomputation.
- The current reader already runs in one select-only transaction and returns only through final
  aggregate preflight. Its source check collapses projection/order and digest disagreements into one
  `hash_mismatch`, and both source and prepared diagnostics currently orient stored values as
  expected and canonical values as actual. The accepted aggregate preflight uses the opposite,
  authority-correct orientation for prepared results.
- Current focused tests provide a fresh migration-backed aggregate fixture and a valid repeated-read
  order control. No new harness, migration, public error family, or third implementation file is
  needed.

### Authority Reconciliation

1. **Representable source duplicates and reorder.** A duplicate is representable only inside the one
   stored array relative to the independently validated producer projection: append one exact
   producer member already present in the stored projection and report the first unexpected repeated
   stored position. A reorder is representable only as an equal-cardinality permutation with the
   exact same members but a different sequence; report the first differing position. A producer
   projection that itself contains repeats is not contradictory when storage matches it, because no
   accepted uniqueness rule exists. There is no noncontiguous-source-ordinal class. An arbitrary
   replacement or omission is neither this duplicate class nor reorder and must not be normalized
   into one.
2. **SQL-impossible singular/owner duplicates.** Duplicate common revision, document payload, final
   artifact, role-keyed document owner, and reused common/physical owner identities are rejected by
   installed keys. Existing migration metadata and direct-SQL rejection tests are valid evidence for
   those storage invariants. They are not reader cases. Reconstructing a table, dropping a key,
   disabling uniqueness, or adding an unchanged-behavior reader test would be forbidden reproof, not
   evidence for a reachable trusted-read diagnostic. Existing defensive reader cardinality branches
   may remain but receive no fixture or implementation allocation.
3. **Artifact hash.** No artifact hash contradiction is authorized for this reader. A well-shaped
   changed `content_sha256` is the only durable content digest, so the aggregate alone has no expected
   value against which to call it wrong. `blob_sha` is a Git object identity, not an accepted second
   SHA-256 of content. Artifact bytes or an independently authoritative digest would require a later
   accepted owner and renewed Design/Structure authority. This child must only shape-decode and
   preserve the artifact hashes.
4. **Expected/actual orientation.** `expectedSha256` is always the canonical trusted value and
   `actualSha256` is always the contradictory durable value. For source projection disagreement,
   expected is the canonical trusted producer-projection digest and actual is the canonical digest of
   stored `source_set_json`. When the projection agrees but `source_set_sha256` differs, expected is
   that same canonical producer digest and actual is the stored row digest. For prepared results,
   expected is `canonicalSha256(decodedDocument)` and actual is `prepared_result_sha256`.

## Scope Signals

| Signal | Finding | Effect |
| --- | --- | --- |
| Independently useful acceptance groups | The four representable diagnostics share one reader slot, one fixture, one error vocabulary, and one final all-or-error boundary. | Against split |
| Multiple state machines or effect protocols | None; this is select-only classification and adds no mutation, transition, quarantine, or external read. | Against epic |
| Distinct trust boundaries | Trusted producer projection versus durable source projection, and decoded prepared value versus stored digest, are two checks inside the same aggregate-read boundary. | Review checkpoints, not child features |
| Reusable framework plus consumers | No framework or new consumer is introduced; narrow local helpers are sufficient. | Against split/epic |
| Separately releasable or revertible parts | Classifier code without exact one-fault evidence is incomplete; splitting source and prepared cases would divide one promised diagnostic contract. | Against split |
| One detailed Design covers the change | Yes, once the bead and Structure stop claiming unsupported artifact and SQL-impossible reader behavior. | Supports FeatureFit after clarification |
| Admission trigger | High estimate is 500. | Ordinary FeatureFit review |

## Decision Rationale

`FeatureFit` is the size/decomposition verdict because the authorized executable outcome is one
bounded extension to one public reader in two existing files, with a 500-line high estimate. Source
duplicate/reorder classification and source/prepared hash diagnostics cannot safely be separated from
their exact real-SQLite evidence.

`SplitFeature` would create test-family or classifier-family fragments rather than independently
useful vertical outcomes. `EpicFit`/`PromoteToEpic` is unsupported because there is no independently
designable capability, second lifecycle, external protocol, or framework. `KeepLarge` is unnecessary
below the trigger. `NeedsResearch` is also unwarranted: the representation and missing artifact hash
authority are known exactly. The blocker is contradictory accepted wording, which scope review cannot
silently rewrite.

## Required Authority and Structure Edits Before Plan

### Bead acceptance — acceptance **must change**

1. Replace “Reads detect duplicate source, artifact, payload, or ownership rows” with: “Reads detect
   the representable duplicate stored source-array class. Migration `0011` metadata and existing
   direct-SQL tests remain acceptance evidence that duplicate common revision, document payload,
   singular artifact, owner role, and physical-operation ownership are rejected at insertion.”
2. Replace source-and-artifact reorder/noncontiguous wording with: “Reads detect an exact permutation
   of the ordered stored source projection relative to trusted producer authority. Artifact reorder
   and noncontiguous source/artifact ordinals are out of scope because those durable ordinals or
   collections do not exist.”
3. Replace “Canonical source-set, prepared-result, and artifact hash disagreement” with “Canonical
   source-set and prepared-result hash disagreement.” Add: “Artifact hashes are strictly decoded and
   preserved; mismatch diagnosis is deferred until accepted authority supplies content bytes or an
   independent digest.”
4. Apply the same substitutions to all three scenarios and to the one-fault real-SQLite matrix. State
   that existing SQL evidence is credited without adding unchanged-behavior migration tests.

These edits narrow unsupported mechanism language while retaining all behavior the accepted durable
model can establish. Without them, implementation could pass the proposed tests while failing the
literal bead acceptance.

### Parent accepted Structure and recursive allocation

Revise the parent Desired End State, Phase 2/3 reader wording, and T4b coverage row wherever they say
ordered artifact references, artifact ordinals/reorder, duplicate payload/artifact/owners as reader
fixtures, or canonical artifact hash recomputation. Replace them with the four representable cases
above and explicitly credit the already accepted migration `0011` SQL evidence for impossible
duplicates. Keep T4b at **220 / 350 / 500**; no lines move to T4a or T4c.

### `.1.7` Structure revision

1. Change the recommendation from clarification-blocked/prospective to `FeatureFit` only after the
   bead and parent edits are accepted; record the four authority resolutions above as resolved, not
   open questions.
2. Define the duplicate fixture unambiguously as appending one exact already-present producer member
   to `source_set_json`; define reorder as an exact equal-cardinality permutation. Do not create a
   general uniqueness contract or source ordinal.
3. State the branch-specific source hash actual value: canonical stored-projection digest for a
   projection mismatch, stored row digest for a matching projection with a bad row hash. Preserve the
   canonical-trusted expected/stored-contradiction actual orientation for prepared results.
4. Retain zero migration changes, zero artifact hash/reorder cases, zero impossible duplicate reader
   cases, the existing first-diagnostic order, and exact **65/100/145 + 155/250/355 = 220/350/500**
   allocation.

## Review Strategy

After those edits are accepted, the Plan may proceed as one phase under these exact constraints:

1. Change only `src/qrspi/store.ts` and `test/qrspi/store.test.ts`; any migration, contract/domain,
   third implementation file, artifact-content access, or public error-family change requires renewed
   review.
2. Preserve strict selector decoding, one select-only transaction, the `.1.6` first-diagnostic
   sequence, produce-before-publish owner order, and final preflight as the sole success return.
3. Classify only the exact appended-repeat duplicate and equal-member permutation reorder after source
   presence, strict source/projection shape, and identity validation. Compare left-to-right; never
   sort, normalize, deduplicate, or trust the rejected projection.
4. Emit canonical trusted producer digest as expected and the applicable stored projection/row digest
   as actual; emit canonical decoded Document digest as expected and stored prepared digest as actual.
5. Add only four fresh one-durable-field real-SQLite cases: duplicate stored source entry, reordered
   stored projection, changed stored source-set digest, and changed stored prepared-result digest.
   Every case must prove exact `Left`, complete aggregate record identity, bounded details, and no
   exposed aggregate fragment. Reuse the existing valid repeated-read test as the no-normalization
   order control.
6. Reuse migration metadata/direct-SQL evidence by citation and regression execution only. Do not add
   duplicate singular/payload/artifact/owner tests, defeat constraints, or reprove unchanged SQL
   behavior.
7. Add no artifact hash or artifact-order diagnostic, operation-input hash expansion, containment
   snapshots, quarantine spy, WorkflowStart/inactivity proof, transition, repair, or lifecycle work;
   `.1.8` retains its allocation.

No Plan may be written from the current unamended bead and clarification-blocked Structure.
