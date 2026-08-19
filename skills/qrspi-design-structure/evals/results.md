# QRSPI Design and Structure Evaluation Results

## 2026-08-19: Iteration 1, Structure capability identity and split routing

Each fixture ran once as a Structure producer in a fresh general subagent with the
repository skill and its bundled contract, and nothing else. Producers were told to work
from the fixture alone: no repository tree, no other fixture, no `evals.json`, and no
access to the recorded `workflowd-vs3.4` experiment reports. A separate grader subagent
then applied the assertions in `evals.json` to each artifact, quoting the line that
decided each one.

| Fixture                          | Shape                                    | Capabilities | Routes                | With skill |
| -------------------------------- | ---------------------------------------- | ------------ | --------------------- | ---------: |
| `workflowd-vs3.4-canonical.md`   | real accepted package, 83 records         | 12           | 12 split              |    11/11   |
| `small-cohesive-ready.md`        | one small cohesive capability             | 1            | 1 ready               |      8/8   |
| `no-spurious-work.md`            | mostly non-work-authorizing records       | 1            | 1 ready               |      9/9   |
| `stateful-mixed-routes.md`       | backend and stateful, mixed               | 4            | 2 ready, 2 split      |     9/10   |
| `ui-surface-mixed-routes.md`     | user interface, mixed                     | 3            | 1 ready, 2 split      |      9/9   |
| `cli-library-mixed-routes.md`    | CLI and library, mixed                    | 4            | 2 ready, 2 split      |    10/10   |
| **Total**                        |                                           |              |                       | **56/57**  |

Every run produced the intended capability set and the intended route for every
capability. No run merged or split an accepted node, invented a capability, created work
from an informational source, owner assignment, risk disposition, verification record, or
prohibition, or let an estimate reach a routing predicate. Every run stopped at
`AwaitingHumanStructureReview` and made no commit, push, pull request, child delivery
record, or tracker change.

### Canonical reproduction

The canonical run reproduces the recorded four-producer result on the real
`workflowd-vs3.4` accepted package: the same twelve capabilities, the same capability
names, D13 preserved as prohibition-only, all twelve routed `SplitFlowRequired`, all 83
records classified, R9 carried with its `workflowd-8bg` follow-up, and the run stopped at
human review. That producer had the contract and the fixture only; it never saw the
experiment reports. It is therefore a fifth independent producer agreeing with the first
four.

### The one failure

`stateful-mixed-routes.md` applied the CLI and library profile to a service balance RPC
that the fixture does not evidence as externally consumed. Every check in that profile
passed, so the route was unaffected, but the selection was wrong. The contract's profile
trigger was tightened after this run to require evidenced external consumers, through a
published package export, a documented command, or a named external consumer, and to say
that a boundary merely reachable over the network is not a published surface. A future
iteration should confirm the fix.

### Contract changes made from these results

Grading surfaced three genuine gaps in the contract, all fixed after the runs recorded
above, so a rerun would grade against slightly different text:

1. The CLI and library profile trigger now requires evidenced external consumers.
2. The contract now says an artifact records which profiles it applied and why, and that
   an arguable extra profile whose checks all pass cannot change a route.
3. Capability dependencies now say a missing accepted edge is not a missing dependency:
   producers derive the rest from what the accepted outcomes require of each other, and
   recording no dependencies is a claim that needs a stated basis. The canonical run
   declared no dependencies for all twelve capabilities on the narrower ground that no
   accepted edge joined two minting nodes, although composition plainly cannot be
   delivered before the things it composes.

### Known fixture limitation

No fixture states the Design policy or promotion policy revisions and hashes, which the
artifact schema asks the binding section to carry. Every producer flagged the gap instead
of inventing values, which is the right failure mode, but it leaves that part of the
binding section untested. Tracked in `workflowd-vs3.14.4.2`.

### Other observations, none route-changing

- One artifact listed a verification edge produced by a prohibition inside a capability's
  authority table. It created no work. Tracked in `workflowd-vs3.14.4.1`.
- Two artifacts justified the profile they declined but not the profile they applied.
- One artifact's ordering rationale claimed ascending exact ID ordering while printing a
  different, still valid, topological order.

No baseline without the skill was run for this iteration.
