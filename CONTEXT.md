# Pull Request Automation

This context receives GitHub pull-request activity and coordinates review, publication, and optional fix work against a precise pull-request state.

## Language

**Webhook Delivery**:
A uniquely identified notification received from GitHub, including its event payload and receipt time.

**PR Observation**:
A pull-request state reported by a Webhook Delivery. It may be stale, duplicated, or ambiguous relative to other observations.

**Authoritative PR Snapshot**:
The current pull-request state obtained directly from GitHub to resolve ambiguous PR Observations.

**Review Target**:
The exact base and head commits, refs, and head-repository provenance against which a review or fix is performed.

**Generation**:
The sequence that groups work for one exact accepted Review Target. Any change to its base commit or ref, head commit or ref, or head-repository provenance starts a newer Generation and supersedes work from older Generations.

**Review Request**:
An ordered request for a review within a Generation.

**Review Result**:
A structured review judgment that either passes the Review Target or requests changes with one or more actionable findings.

**Publication**:
The durable intent to make a Review Result visible on the pull request.

**Review Work**:
Claimable work that produces a Review Result for a Review Request and Review Target.

**Fix Work**:
Claimable work that addresses an actionable changes-requested Review Result from a source Publication.

**Fix Work Enablement**:
An explicit deployment authorization required in addition to Fix Eligibility before Fix Work may be requested or executed. It is disabled by default.

**Fix Eligibility**:
The condition in which a Review Result requests actionable changes and the Review Target belongs to the pull request's repository. Authorization to request eligible Fix Work is separate.

**Fix Checkpoint**:
A durable fixer outcome recording either a prepared commit or that no changes were needed, before Fix Work completes.

**Lease**:
A time-bounded exclusive claim by a worker on a piece of work. Ownership authorizes mutations only while the operation time is strictly before the Lease expiry.

**Work State**:
The durable lifecycle condition of claimable work: ready, leased, scheduled for retry, succeeded, failed, superseded, or quarantined by a data error.

**Data Error**:
A terminal Work State for a durable record that cannot be interpreted as its declared kind of work. It is quarantined so later work can proceed.

**Supersession**:
The condition in which work or a Publication is no longer current because a newer accepted pull-request state or Review Request takes precedence.

**Publication Currentness**:
The condition in which a Publication belongs to the current Generation and latest Review Request for an open, reviewable pull request at its exact Review Target.

**Reconciliation**:
Resolution of an ambiguous PR Observation using an Authoritative PR Snapshot. Only the worker holding its current Lease may apply that snapshot.

**Existing Worktree**:
A matching worktree that already exists independently of the automation lifecycle.

**Managed Worktree**:
A worktree whose lifecycle is owned by the automation.

**CI Target**:
An exact GitHub repository and head SHA, with an explicitly configured set of
workflow names whose latest attempts must all finish before the target is terminal.

**CI Observation**:
A signed workflow-run or check-suite completion delivery, durably recorded before
acknowledgement. An observation triggers bounded reconciliation; it does not by
itself prove that the whole CI Target is complete.

**CI Aggregate**:
The durable pending/success/failure result of a reconciled CI Target, including
failing job names and a replay sequence. It does not authorize PR publication or
advance a Generation.

**Resident Inbox**:
A durable queue of external events for a custodied worker thread. Ending a turn
while a CI wait is registered preserves the active Agent Run; the queued completion
or timeout event starts a later turn. Recovery rechecks session and working-resource
custody before waking a thread.

**Worker GitHub Capability**:
A short-lived authorization bound to one live Agent Run and its configured
repository/permission policy. It permits obtaining a GitHub App installation token;
it conveys neither the App private key nor another worker's identity.
