# Authority model

## Order

Apply this order when sources differ:

1. The current ticket's task, acceptance criteria, out-of-scope statements, and explicit
   current-ticket human clarifications define current scope.
2. Dependencies and dependents or blockers define ownership boundaries between tickets.
3. Parent and sibling issues provide context and negative ownership evidence. Their
   requirements are not inherited by the current ticket.
4. Architecture documents constrain an owned capability's implementation. They do not
   add capabilities to current-ticket scope.
5. Missing code describes current state. It does not show which ticket owns the missing
   capability.

Accepted Questions and Research explain evidence and implications but cannot enlarge the
ticket. A technical artifact that proposes changed product scope needs current-ticket
human clarification before it gains authority.

Unavailable lower-order evidence does not demote a capability explicitly owned by the
current ticket. Classify that row from the available higher authority, record the source
as `Unavailable`, and let the source-gap verdict preserve the need to rerun the review.
Use `NeedsHumanClarification` on the row only when the missing evidence could resolve a
conflict or boundary that the current ticket itself leaves open.

## Classifications

Assign exactly one classification to each atomic capability. Split a claim rather than
giving one row several classifications. A narrow inter-ticket handoff or extension point
is `RequiredEnablingSeam` even when the current ticket explicitly requires it; use
`Required` for the current ticket's owned end behavior and internal support.

| Classification | Use when | Boundary test | Normal action |
| --- | --- | --- | --- |
| `Required` | The current ticket owns the capability as an end behavior or as internal support indispensable to a current acceptance criterion. | Removing it would leave a named current-ticket requirement unsatisfied, and its primary purpose is not an inter-ticket handoff or extension point. | Keep it, or add/strengthen Design coverage. |
| `RequiredEnablingSeam` | The current ticket needs or explicitly requires a minimal contract, reference, policy field, state, handoff, or extension point while another ticket owns the later lifecycle. | The capability's primary purpose is to connect to the neighboring owner, and it does not start, execute, persist, retry, deliver, or complete that lifecycle. | Keep the narrow seam and name the downstream owner. |
| `OwnedByAnotherTicket` | A dependency, dependent, blocker, or relevant sibling explicitly owns the capability. | The neighboring ticket's task or acceptance criteria describe this behavior, not merely its future use. | Remove or defer it; retain a separately justified enabling seam if needed. |
| `UnsupportedExpansion` | No current-ticket authority requires the capability and no neighboring ticket supplies an ownership conflict. | Support comes only from the parent, architecture, a technical artifact, missing code, or reviewer preference. | Remove it, or obtain an explicit ticket change before retaining it. |
| `NeedsHumanClarification` | Available authority conflicts, a plausible enabling seam cannot be separated from a neighboring lifecycle, or missing evidence prevents a defensible ownership decision. | Two or more assignments remain reasonable after applying the authority order. | Preserve the alternatives and ask one ownership question. |

Use `NeedsHumanClarification` for a real unresolved decision, not as a substitute for
research. Explicit neighboring ownership is `OwnedByAnotherTicket`; silence with no
plausible current-ticket requirement is `UnsupportedExpansion`.

## Enabling seam test

A seam is minimal only when all of these hold:

- a current-ticket requirement or output needs it;
- its shape is limited to stable policy, identity, typed data, state, or an invocation
  boundary;
- the current ticket can finish and verify its own behavior without running the
  downstream lifecycle; and
- the neighboring ticket retains its independently testable operations, persistence,
  effects, retries, and user-visible outcome.

A consumer using the current ticket's ordinary result does not make that whole result a
seam. Classify only the dedicated handoff, policy, reference, state, or extension boundary
as `RequiredEnablingSeam`.

If one Design sentence includes both the seam and downstream execution, split it into
separate ledger rows before classifying it.

## Evidence

Cite source identity and the decisive field, section, criterion, or claim. Explain the
ownership link in the row rather than listing a source without its implication. A flagged
expansion needs positive boundary evidence: a neighboring ownership statement, a current
out-of-scope statement, or the absence of current authority after named sources were
checked.
