# Risk and control model

## Evidence chain and materiality

A risk is a possible loss of an intended outcome, not a topic from a generic checklist.
Retain a candidate only when evidence connects all five links:

`Design decision -> affected surface -> trigger -> failure mode -> consequence`

A failure mode is material when its evidence-backed consequence could change acceptance
of the Design, violate a current requirement or invariant, cause meaningful harm to
users, data, security, privacy, compliance, finances, or operations, cross an owned
system or ticket boundary, or require an explicit risk decision. Explain the materiality
in words. A score never establishes it.

Record a candidate with a broken evidence chain under Excluded Speculation. Missing
evidence can itself leave material uncertainty, but it does not turn the speculative
failure mode into a fact.

## Affected surfaces

Trace each Design decision across all eight surfaces:

| Surface             | Examine                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Code                | Rules, state transitions, concurrency, resource use, compatibility, and failure handling       |
| Data                | Integrity, confidentiality, lifecycle, migration, retention, reconciliation, and recovery      |
| Configuration       | Defaults, flags, secrets, environment differences, validation, and drift                       |
| Interfaces          | Schemas, protocols, identity, authorization, ordering, idempotency, and consumers or providers |
| External effects    | Messages, files, payments, notifications, third parties, and irreversible actions              |
| Operations          | Deployment, observability, alerting, support, rollback, capacity, and incident response        |
| Users               | Roles, access, accessibility, error outcomes, trust, and affected populations                  |
| Neighboring tickets | Enabling seams, downstream controls, sequencing, and ownership handoffs                        |

`NoMaterialImpact` needs positive evidence about the decision and surface. Silence,
missing code, or an unavailable source is not evidence of no impact.

## Five-by-five rating aid

Rate impact and likelihood independently. Keep detectability, reversibility, blast
radius, and uncertainty separate rather than hiding them in the score.

### Impact

| Level | Token         | Anchor                                                                                     |
| ----: | ------------- | ------------------------------------------------------------------------------------------ |
|     1 | `Negligible`  | No meaningful outcome loss; effect is trivial and contained.                               |
|     2 | `Minor`       | Limited outcome loss affecting a small scope with straightforward correction.              |
|     3 | `Moderate`    | Material but bounded outcome loss, degraded service, or nontrivial recovery.               |
|     4 | `Significant` | Major outcome failure, broad disruption, serious harm, or difficult recovery.              |
|     5 | `Severe`      | Maximum credible consequence such as catastrophic harm, systemic loss, or irreversibility. |

### Likelihood

State the exposure basis, such as per operation, deployment, account, or time period.

| Level | Token           | Anchor                                                                       |
| ----: | --------------- | ---------------------------------------------------------------------------- |
|     1 | `Rare`          | Requires exceptional conditions and is credible but uncommon.                |
|     2 | `Unlikely`      | Could occur, but ordinary exposure usually avoids the trigger.               |
|     3 | `Possible`      | Plausible under ordinary exposure and expected occasionally.                 |
|     4 | `Likely`        | Expected repeatedly across relevant exposure.                                |
|     5 | `AlmostCertain` | Expected in nearly every relevant exposure or already consistently observed. |

Use the bundled calculator for every exact score:

```bash
bun <skill-directory>/scripts/risk-matrix.ts score \
  --impact Significant \
  --likelihood Rare
```

It calculates `impact x likelihood` under matrix `5x5-v1`:

| Score | Band       |
| ----: | ---------- |
|   1-4 | `Low`      |
|   5-9 | `Moderate` |
| 10-14 | `High`     |
| 15-19 | `VeryHigh` |
| 20-25 | `Critical` |

For example, `Significant (4) x Rare (1) = 4 / Low`. Always retain both axes because
different risk shapes can share a score. The levels are ordinal: do not add, average, or
claim ratios between scores. A `Low` rating is not acceptance, a `Critical` rating is not
a Design verdict, and no score or band appears in the verdict rules.

Record uncertainty as `Low`, `Medium`, or `High` with its cause. Assign an exact axis only
when evidence supports its anchor and exposure basis; language such as "could" or one
example is not enough to fill the matrix. If evidence supports a range, calculate and
report the endpoint combinations. If an axis cannot be supported, record it as `Unknown`
and omit the score rather than inventing a midpoint. Use the same exposure basis for
current and residual likelihood so the ratings remain comparable.

Deterministic evidence supports a likelihood anchor only when it proves the failure
occurs on the stated exposure basis. Verification that an assumed control works does not
establish how often an implementation defect or control escape occurs. Without source
evidence for that occurrence frequency, record likelihood as `Unknown`.

Record current and residual ratings separately. A residual rating names every assumed
control; it is not a claim that those controls already exist.

## Risk characterization

For every `R*`, record:

- the evidence chain and affected outcome;
- current impact, likelihood, matrix result, exposure basis, and uncertainty;
- detectability: signal, observer, and whether detection is before, at, or after effect;
- reversibility: automatic, operator recovery, migration, or irreversible;
- blast radius: the bounded affected operations, components, users, data, or external
  parties;
- current and required controls; and
- residual rating, assumptions, materiality, and decision status.

Qualitative explanations remain authoritative when the numeric aid compresses distinct
risk shapes into the same result.

## Controls

Consider every control kind for every material risk:

| Kind          | Purpose                                                           |
| ------------- | ----------------------------------------------------------------- |
| `Prevention`  | Remove the trigger or stop the failure before it occurs.          |
| `Detection`   | Produce a timely, owned signal that distinguishes the failure.    |
| `Containment` | Bound exposure or stop propagation after failure begins.          |
| `Recovery`    | Restore the intended state or outcome and reconcile side effects. |

Use `NotApplicable` only with evidence explaining why that control kind cannot improve
the risk. A measure is a control only when it credibly changes the risk in the named way:
detection must produce an actionable signal, containment must bound propagation, and
recovery must restore or reconcile the intended outcome. Inspection without a restoring
action is not recovery. Verification proves controls; it does not become a control unless
it directly prevents or detects exposure in operation.

Use `Missing:<needed disposition>` when a useful control kind lacks an owned control. Use
`PendingDecision:<question or R* ID>` when the control choice depends on the unresolved
human tradeoff. These dispositions preserve an incomplete mitigation honestly; they do
not receive `C*` IDs or verification obligations. A `Design`-owned missing disposition
supports `ReviseDesign`; an otherwise complete Design with a pending material tradeoff
supports `NeedsRiskDecision`. `ImpactReady` permits neither for a material residual risk.

For a compound trigger, assess `Prevention` against the full trigger and failure mode,
not only an uncontrollable initiating event. If an unresolved option could remove a
trigger condition or stop exposure before failure, record `PendingDecision:<R* ID>`
rather than `NotApplicable`.

Do not fill a control kind with a measure aimed at another risk. Preventing a secondary
effect is not prevention of the stated trigger, and restoring future service is not
recovery of an already lost outcome unless evidence provides retry or reconciliation.

Every required control has one ownership class:

- `CurrentTicket` for a control obligation owned by the current work;
- `RequiredEnablingSeam` for the narrow contract, state, policy, or handoff needed by a
  downstream owner; or
- `DownstreamTicket:<id>` when that ticket explicitly owns the control lifecycle.

Consuming an outcome or status does not establish downstream control ownership. Require
an explicit lifecycle assignment in the issue graph or ownership report; otherwise keep
the control with its supported owner or mark the ownership disposition missing.

Architecture constrains control design but does not create ticket ownership. Reuse the
matching ownership report and issue graph rather than performing a second ownership
review. Unavailable evidence does not create a required control or owner: preserve
evidence acquisition, prevented exposure, deferral, and acceptance as human options
unless the ticket, ownership report, Design, or issue graph already assigns the
obligation. A human residual-risk decision is not a control and is recorded separately.

A downstream control is complete only when its ticket, owner, verification target, and
safe delivery sequence are explicit. Until it exists, a release guard or equivalent
containment must prevent exposure to the uncontrolled path.

Use these delivery phases without turning them into tasks: `Design`, `Structure`,
`Implementation`, `BeforeExposure`, `Runtime`, and `Recovery`. A `Design` control means
the decision itself must change and therefore supports `ReviseDesign`. A verifiable
cross-cutting obligation may be handed to Structure under its stable `C*` ID.
