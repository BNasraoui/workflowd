# Evaluation Fixture: Missing Acceptance Coverage

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `reports-420@fixture-1` | Complete, including task, acceptance criteria, and out-of-scope statements |
| One-hop issue graph | `reports-420-graph@fixture-1` | Complete, including parent, dependencies, dependents or blockers, and relevant siblings |
| Accepted Questions | `reports-420-questions@fixture-1` | Complete |
| Accepted Research | `reports-420-research@fixture-1` | Complete |
| Draft Design | `reports-420-design@fixture-1` | Complete |
| Architecture references | `reports-signing-architecture@fixture-1` | Complete for the cited signing boundary |

## Current Ticket

ID: `reports-420`

Title: Sign immutable report export manifests

Task:

- Sign the manifest for one immutable report export.
- Record enough signer metadata for downstream verification.

Acceptance criteria:

- The signature covers the exact manifest bytes and content hash.
- The signed result records the signer key ID and signature algorithm.
- Verification rejects a different manifest revision or content hash.

Out of scope:

- Key rotation, revocation distribution, and external trust policy.

## Parent

`reports-400`: Export accepted reports in verifiable immutable formats.

## Dependencies

- `reports-419` (closed): Produces immutable manifests with stable content hashes.

## Dependents and Blockers

- `reports-421`: Verifies signed manifests. It needs the exact manifest identity,
signature, signer key ID, and algorithm from this ticket.

## Relevant Siblings

- `reports-422`: Rotate signing keys. It owns rotation policy, not metadata emitted by a
single signing operation.

## Accepted Questions

- Which metadata must accompany a signature so verification does not infer key state?

## Accepted Research

- Verification requires an explicit signer key ID and algorithm alongside the signature.
- The manifest identity and content hash bind verification to exact accepted bytes.

## Draft Design

1. Build a canonical signed payload from the immutable manifest bytes, manifest revision,
   and content hash, then sign that payload with the configured report-export key.
2. Return the manifest revision, content hash, and signature for downstream verification.

## Architecture References

- Signed export manifests carry exact source identity and explicit signer metadata.
- Rotation and trust policy remain separate from signing one immutable manifest.
