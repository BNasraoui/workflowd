# Canonical Structure replication comparison

## Inputs

This comparison covers a fresh independent replication of the canonical graph-derived,
repository-evidence-routed Structure protocol. Both producers used accepted Design revision 4,
repository base `42e129ab75ea0de39aa1bd6db4502325cd3effb1`, and verified export SHA-256
`f8bd728183d02da4b79db6448cf8dbd3403a0e79e2bf39008d1d20efd4133977`.

| Run | Producer session | Artifact SHA-256 |
| --- | --- | --- |
| Replication A | `ses_0757fd8c4ffeMHJVCGzJkhqwCM` | `cd99ecdfe750b8d9a5f5be371d6bbec38e4b28626d4aab092e18c8265a8cf105` |
| Replication B | `ses_0757fd902ffeFD1evM4vjV1msq` | `05461a7df76679b310499e0c325bfd0b44e6c790f6517916d59a1153824bea20` |

## Replication result

The replication confirms substantive determinism:

- Both contain exactly CAP-D1 through CAP-D12 in the same order and with identical names.
- Both preserve D13 as prohibition-only.
- Both route all twelve capabilities `SplitFlowRequired`.
- Both cite the same authority and exact export edge IDs.
- Both classify all 83 records and map AC/D/C/V/R/O/R9/owners to the same capabilities or
  external owners.
- Both express the same semantic dependencies, outcomes, verification ownership, likely
  implementation surfaces, exclusions, R9/`workflowd-8bg` treatment, and snapshot deviation.
- Both stop at `AwaitingHumanStructureReview` and authorize no downstream work.

Across the original canonical pair and this replication pair, four independent producers
therefore agreed on capability identity, capability order, route, semantic coverage, and stop
state.

## Residual checklist variation

Two of 84 per-run checklist cells differed in the replication pair. Neither difference changed
the route because each affected capability had other failed checks.

| Capability and check | Replication A | Replication B | Cause |
| --- | --- | --- | --- |
| CAP-D2: No new transaction boundary | Pass | Fail | A treats exact request persistence as using CAP-D3's generic store boundary; B treats D2's required persisted exact request hash as introducing a new D2 transaction until that seam exists. |
| CAP-D10: Existing complete named seam | Fail | Pass | A requires the current Layer seam to already name and accept every complete D10 dependency; B treats existing `makeLiveLayer`/runtime composition as the named accepting seam even though the new catalog/service/publisher/loop inputs do not yet exist. |

The route function is robust to these cells, but their evidence terms can be tightened:

1. A capability fails `No new transaction boundary` when its accepted outcome requires an
   atomic persistence or guarded update that no current complete named seam exposes. A future
   dependency's planned generic store primitive is not current repository evidence.
2. A capability passes `Existing complete named seam` only when the current seam already names
   and accepts all direct dependency interfaces required by the complete capability. A generic
   composition function that will need new service tags or ports is not yet a complete seam.

These clarifications remain qualitative and evidence-based. They introduce no changed-line
threshold, task-count target, size limit, or implementation plan.

## Determination

The protocol has reached a decent level of determinism for Structure:

- graph decisions determine capability identity;
- repository evidence determines whether each fixed capability needs split flow;
- a fixed schema normalizes the review surface;
- changed-line estimates and delivery decomposition remain outside Structure;
- the workflow stops at human Structure review.

Remaining prose and evidence-cell variation does not alter capability scope, routing, authority,
ownership, or workflow state.

## Stop state

No split flow, Plan, Implementation, child delivery Bead, product-code change, commit, push, or
pull request was created.
