# Evaluation Fixture: Required Design Change

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `reports-430@fixture-1` | Complete, including task, acceptance criteria, and out-of-scope statements |
| One-hop issue graph | `reports-430-graph@fixture-1` | Complete, including parent, dependencies, dependents or blockers, and relevant siblings |
| Accepted Questions | `reports-430-questions@fixture-1` | Complete |
| Accepted Research | `reports-430-research@fixture-1` | Complete |
| Draft Design | `reports-430-design@fixture-1` | Complete |
| Architecture references | `reports-content-identity@fixture-1` | Complete for the cited checksum constraint |

## Current Ticket

ID: `reports-430`

Title: Record checksums for immutable report exports

Task:

- Compute a checksum over one immutable report export.
- Return the checksum with the export's exact revision identity.

Acceptance criteria:

- The checksum covers the exact exported bytes.
- Repeating the calculation over the same bytes produces the same checksum value.
- The result contains the export revision, checksum algorithm, and checksum value.

Out of scope:

- Artifact signing, key management, and external trust policy.

## Parent

`reports-400`: Publish immutable and verifiable report exports.

## Dependencies

- `reports-429` (closed): Produces immutable export bytes and their exact revision identity.

## Dependents and Blockers

- `reports-431`: Displays export integrity details. It consumes the checksum result but
  does not own checksum calculation.

## Relevant Siblings

- `reports-432`: Sign report exports. It owns signatures and keys, not content checksums.

## Accepted Questions

- Which checksum algorithm matches the repository's stable content-identity format?

## Accepted Research

- MD5 would detect ordinary byte changes but does not match the repository's content
  identity format.
- SHA-256 is the required checksum algorithm for immutable artifact identities.

## Draft Design

1. Compute a deterministic MD5 checksum over the exact immutable export bytes so the same
   bytes always produce the same value.
2. Return `ExportChecksum { exportRevision, algorithm: "md5", value }` to integrity
   consumers.

## Architecture References

- All immutable artifact content identities use lowercase SHA-256 and identify the
  algorithm explicitly.
- This rule constrains checksum representation; it does not add signing or trust-policy
  scope to checksum tickets.
