# Structure Child Creation Manifest

Parent: `workflowd-vs3.4.3.1.2.2.2` (Reject immutable-reference and diagnostic contradictions)

- `workflowd-vs3.4.3.1.2.2.2.1` - Prove artifact-reference rejection
  - Dependencies: parent-child relationship with `workflowd-vs3.4.3.1.2.2.2`; blocks on completed fixture `workflowd-vs3.4.3.1.2.2.1`; no sibling dependency.
- `workflowd-vs3.4.3.1.2.2.2.2` - Prove implementation commit and checkpoint rejection
  - Dependencies: parent-child relationship with `workflowd-vs3.4.3.1.2.2.2`; blocks on completed fixture `workflowd-vs3.4.3.1.2.2.1`; no sibling dependency.
- `workflowd-vs3.4.3.1.2.2.2.3` - Correct and prove diagnostic pair completeness
  - Dependencies: parent-child relationship with `workflowd-vs3.4.3.1.2.2.2`; blocks on completed fixture `workflowd-vs3.4.3.1.2.2.1`; no sibling dependency.

Each child is an open P1 task with inherited labels `cap-d3`, `qrspi`, `sqlite`, and `stage-runtime`. Each requires its own Structure scope review before Plan and is not an implementation-ready leaf.
