# Post-Structure Scope Review: Define the Strict Document Aggregate Boundary

## Verdict
`FeatureFit`

## Estimate
estimatedChangedLines:
  low: 315
  likely: 435
  high: 590
confidence: medium
decision: FeatureFit

| Surface | Planned change | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| `src/qrspi/stage-runtime.ts` | New aggregate identities, lifecycle literals, strict aggregate Schema, and aggregate-level semantic filters | 135 | 175 | 225 |
| `src/qrspi/store.ts` | One bounded data-error extension and one pure strict-preflight port method | 30 | 45 | 65 |
| **`src/**` subtotal** |  | **165** | **220** | **290** |
| `test/qrspi/store.test.ts` | One aggregate builder, one accepted aggregate case, and representative structural, pointer, artifact, ownership, and prepared-hash failures | 150 | 215 | 300 |
| **`test/**` subtotal** |  | **150** | **215** | **300** |
| Migrations, configuration, and required documentation | No changes required by the revised Structure | 0 | 0 | 0 |
| QRSPI workflow artifacts | Review/process artifacts are not implementation-bearing | 0 | 0 | 0 |
| **Total** |  | **315** | **435** | **590** |

## Evidence

- The revised Structure has one implementation phase and names exactly three changed files: one new production module, one narrow extension to the existing store module, and one new focused test module. It explicitly excludes SQL, migrations, persistence rows, transactions, reload, allocation, transition, claims, progression, bootstrap, quarantine, and runtime mutation.
- `src/qrspi/contracts/common.ts` is 477 lines and already owns the reusable bounded primitives and canonical representations required here: `ExactStageScope` at lines 39-48, `ArtifactReference` at lines 204-216, `ExactStageSources` and its ordered source-set hash and authority filters at lines 325-366, and the tagged `PreparedStageOutput` at lines 388-400. The new module composes these existing authorities rather than reimplementing them.
- The installed baseline in `src/store/migrations.ts` fixes the local representation choices the aggregate must mirror: StageRun state literals and three same-run guarded pointers at lines 658-723; revision identity, state literals, bounded non-null owner-crossing key, and source-set fields at lines 726-758; optional paired prepared result/hash at lines 837-863; and one artifact reference per document revision with no ordinal or reference-hash column at lines 932-961.
- `src/qrspi/store.ts` is 1,513 lines, but the required edit is localized to the `QrspiStorePort` declaration at lines 193-286, `QrspiStoreDataError` at lines 290-302, its detail mapper at lines 312-339, and the object returned by `make`. The planned method performs Schema decoding and error mapping only and requires no SQL branch or transaction helper.
- Existing strict decode and bounded-error mapping patterns are already present in `src/qrspi/store.ts`: `readStageProduceInput` uses excess-property rejection and maps malformed and canonical-hash failures at lines 547-598. This materially limits new store-seam work.
- Existing tests already establish the reusable contract evidence that the Structure does not repeat. `test/qrspi/contracts.test.ts` is 1,248 lines and covers exact sources, prepared Document output, ordered source-set hashing, nested scope agreement, and encoded bounds; `test/qrspi/source-assembly.test.ts` is 769 lines and covers `ArtifactReference`, accepted-pointer identity, source ordering, repository identity, and source-content hashes.
- Migration 0011 already has a large dedicated real-SQL fixture and invariant suite beginning at `test/store/migrations.test.ts:665`. The revised Structure correctly assigns no changed lines to that surface because this child neither changes nor reproves the installed SQL shape.
- The estimate reserves most uncertainty for the new aggregate fixture. A complete `ExactStageSources` value is structurally rich, but one deterministic builder can share it across the accepted case and the six representative aggregate-level failure mechanisms. The high estimate allows additional typed helper and diagnostic assertion detail without expanding into primitive, SQL, or permutation suites.

## Scope Signals

- Independently useful acceptance groups: weak. Schema definition, public preflight exposure, and focused proof form one caller-visible outcome; without all three, the next atomic-persistence child lacks a trusted boundary.
- Multiple durable state machines or external-effect protocols: absent. Lifecycle values are decoded literals only. This child adds no transition machine, persistence protocol, lease, transaction, external effect, or recovery behavior.
- Distinct trust boundaries: one. Unknown caller input crosses one strict Schema/preflight boundary and is either returned as the exact decoded document aggregate or rejected with one bounded diagnostic before SQL.
- Reusable framework plus consumers: absent. The new module is the exact document aggregate boundary itself, while the store method is its narrow public seam; no generic aggregate framework or second consumer is introduced.
- Separately releasable or revertible parts: weak. The Schema without the port is not the ticket's persistence-facing contract, and the port without the Schema and proof is unusable. The tests verify the same boundary rather than defining an independent outcome.
- One detailed Design covers the whole change: yes. Accepted Design revision 3 assigns Schema decoding, canonical hashes, semantic identity comparison, exact producer/publication ownership, immutable document artifact authority, and bounded diagnostics to one D3 storage boundary. The revised Structure narrows that design to the pre-persistence document slice without introducing a second design problem.
- Admission trigger: not crossed. The complete high estimate is 590 changed lines, including production-quality tests and bounded diagnostics, well below the 1,000-line admission trigger.
- Split pressure is further reduced by evidence reuse: primitive bounds, ordered technical-source identity, pointer integrity, content hashes, artifact shape, migration shape, preservation, and runtime inactivity already have baseline coverage and are not deferred obligations of this change.

## Decision Rationale

The complete production-quality change is a reviewable unit: one strict aggregate definition, one pure store-port preflight, and one focused test surface. Its likely estimate is 435 changed lines and its high estimate is 590, with no migration, runtime integration, or external-effect protocol hidden behind the narrow API.

Dividing the work would create horizontal fragments rather than independently useful vertical outcomes. A Schema-only change would not expose the ticket-required public contract; a port-only change cannot exist safely without the aggregate decoder and bounded diagnostics; and tests are verification of the same outcome, not a child outcome. Promotion is unsupported because there is only one accepted Design boundary and one useful deliverable. Keeping an unusually large unit is unnecessary because the estimate does not approach the admission trigger. The repository and Structure provide enough concrete evidence for a credible estimate, so additional research is not required.

The revised representation preserves the complete ticket obligation without inventing unsupported SQL shapes. Ordered immutable-reference identity is allocated to the reused ordered `ExactStageSources` contract, while the aggregate's final document artifact is the installed singular `ArtifactReference`. Producer/publication ownership is allocated to two distinct named operation-ID fields rather than a role array. This matches the accepted Design's document producer/publication relationship and the current migration baseline while retaining strict tag, pointer, nested identity, source, prepared-result, artifact, ownership, and hash checks before SQL.

## Review Strategy

Review the change as one vertical slice in this order:

1. Review `src/qrspi/stage-runtime.ts` as the sole aggregate authority. Confirm that run and revision identities project existing bounded fields, `ExactStageSources` remains canonical, `ExactStageScope` and identity values are derived rather than independently accepted, lifecycle literals match migration 0011, all three pointers are same-run guarded revision identities, the owner-crossing key is bounded and non-null, prepared output is exactly the Document member with its canonical hash, the final artifact is absent or one unwrapped `ArtifactReference`, and producer/publication operation IDs are named and distinct.
2. Review `src/qrspi/store.ts` for seam containment. Confirm that the new record kind and expected/actual detail remain within the existing bounded reason vocabulary, unknown input is decoded with excess-property rejection, structural and semantic failures map deterministically, the exact decoded aggregate is returned, and the method performs no SQL, lookup, transaction, mutation, or reload.
3. Review `test/qrspi/store.test.ts` as focused proof of the one boundary. Require one complete accepted aggregate and one representative assertion for each newly owned mechanism: strict structure/tag, cross-run pointer, final-artifact identity, distinct operation ownership, and prepared-result canonical hash. Reuse one builder; do not expand into test-family, input-permutation, per-field, or failure-variant decomposition.
4. Run `bun test test/qrspi/store.test.ts test/qrspi/contracts.test.ts`, `bun run typecheck`, and `bun run effect:check`. The unchanged contracts suite remains the regression proof for source order/hash, accepted pointers, source content, primitive bounds, excess properties, `ArtifactReference`, and prepared Document output.

Acceptance, control, and risk allocation is complete:

| Obligation | Allocated implementation/proof |
| --- | --- |
| Exact bounded run/revision identity, lifecycle literals, owner-crossing key, and three guarded pointers | `src/qrspi/stage-runtime.ts`; accepted aggregate and cross-run-pointer tests |
| Reuse of `ExactStageScope`, `ExactStageSources`, Document `PreparedStageOutput`, and `ArtifactReference`; no competing domain shape | Direct Schema composition in `src/qrspi/stage-runtime.ts`; complete accepted aggregate assertion; unchanged contract tests |
| Wrong tag, strict structure, relational/nested identity, ordered source authority, prepared-result hash, and artifact hash/identity rejection before SQL | Aggregate filters and strict store preflight; representative new tests; unchanged canonical source/artifact contract evidence |
| Ordered immutable-reference criterion | Reused ordered and hash-bound `ExactStageSources`; unchanged contract/source-assembly evidence; no unsupported artifact ordinal added |
| Producer/publication ownership criterion and mismatched operation-authority risk | Distinct bounded `producerOperationId` and `publicationOperationId` fields plus equality rejection; referenced-operation lookup remains explicitly allocated to the next atomic-persistence child |
| Bounded public error vocabulary and exact preflight seam | `src/qrspi/store.ts`; bounded diagnostic assertions in `test/qrspi/store.test.ts` |
| No allocation, transition, persistence, reload, SQL, or runtime mutation behavior | Absence from the three-file delta, pure preflight implementation, and no SQL test harness |
| Migration shape, upgrade preservation, zero inferred rows, and runtime inactivity | Already completed T1 baseline evidence; zero changed lines and no deferred cleanup in this child |
| QRSPI artifacts | Process evidence only; zero implementation-risk and zero estimated changed lines |
