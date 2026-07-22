# Canonical evidence-routed Structure comparison

## Inputs

Two independent producers used identical accepted Design revision 4 inputs, repository base
`42e129ab75ea0de39aa1bd6db4502325cd3effb1`, and verified export SHA-256
`f8bd728183d02da4b79db6448cf8dbd3403a0e79e2bf39008d1d20efd4133977`.

| Run | Producer session | Artifact SHA-256 |
| --- | --- | --- |
| A | `ses_0758d4397ffeqd1RyTSK9kkkAS` | `424a07f8fdd469c4b84aa5cd016f14797ad20590605f767a2dcfabceabd0c6e4` |
| B | `ses_0758d43b3ffeGPjOkoICbcOslo` | `31a01174b9d6f4397ba1308d9c92d94075f4501baf50e097ef46c127a7e2bd21` |

## Protocol

- Terminal capability identity is graph-derived: exactly CAP-D1 through CAP-D12.
- D13 remains a cross-cutting prohibition and creates no capability.
- Requirements, controls, verification rules, risks, and owners map to the fixed decision
  capabilities through accepted authority and exact export edges.
- `ImplementationReady` requires an existing complete repository seam and no new module,
  interface, transaction, fixture family, durable state/migration, lifecycle, uncertain
  external/cross-owner recovery, or multi-resource recovery fixture.
- Any failed repository-evidence item requires `SplitFlowRequired`.
- No changed-line estimate, numeric threshold, size target, or delivery limit is used.

## Result

The two outputs are substantively identical:

- Exactly 12 capabilities in both, with identical names and D1-D12 scopes.
- All 12 route `SplitFlowRequired` in both.
- D13 is prohibition-only in both.
- All 83 graph records are classified in both.
- AC1-AC11, D1-D13, C1-C18, V1-V11, R1-R9, and O1-O11 have complete equivalent coverage.
- Semantic dependency order is identical:
  CAP-D1 -> D2 -> D3 -> D4 -> D5 -> D6 -> D7 -> D8 -> D9 -> D11 -> D10 -> D12.
- Capability outcomes, verification ownership, likely implementation surfaces, exclusions,
  R9/`workflowd-8bg`, neighboring ownership, and snapshot-deviation treatment are equivalent.
- No factual defect or material semantic difference was found.

The remaining differences are presentational only:

- abbreviated versus full edge-ID notation;
- narrative versus tabular graph classification;
- two summarized checklist conditions versus expanded individual checklist rows;
- section ordering and headings.

## Determination

Fixing capability identity to accepted implementation decisions removed the last substantive
route disagreement. The repository-evidence checklist was already deterministic once applied
to the same capability; graph-derived D1-D12 boundaries made the compared input to that
checklist identical.

This round reached complete substantive determinism for capability identity, route, semantic
coverage, dependency order, and ownership. A fixed output schema can remove the remaining
cosmetic variation without changing product or routing semantics.

## Stop state

Both outputs stop at `AwaitingHumanStructureReview`. No split flow, Plan, Implementation,
child delivery Bead, product-code change, commit, push, or pull request was created.
