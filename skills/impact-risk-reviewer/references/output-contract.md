# Output contract

Return these sections in this order and use the field names exactly.

```markdown
# Impact and Risk Review

## Subject

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | ...                                            |
| Design              | Artifact identity and revision                 |
| Ownership report    | Artifact identity and matching Design revision |
| Review binding      | Embedded fields or separate envelope identity and report digest |
| Source set          | Identity or revision                           |
| Workflow Generation | ...                                            |
| Policy revision     | ...                                            |

## Verdict

`ImpactReady | ReviseDesign | NeedsRiskDecision`

## Human Summary

<Two to four sentences naming the decisive impact result and next action.>

## Source Inventory

| Source | Status                                    | Revision and completeness | Relevance |
| ------ | ----------------------------------------- | ------------------------- | --------- |
| ...    | Examined, ConfirmedAbsent, or Unavailable | ...                       | ...       |

## Design Decision Inventory

| ID        | Source decision                         | Decision | Intended outcome | Design evidence |
| --------- | --------------------------------------- | -------- | ---------------- | --------------- |
| D1 or D1a | Numbered item, section, or diagram node | ...      | ...              | ...             |

## Affected Surface Trace

| Decision | Surface                                                                                          | Disposition                         | Evidence |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- | -------- |
| D1       | Code, Data, Configuration, Interfaces, ExternalEffects, Operations, Users, or NeighboringTickets | Specific impact or NoMaterialImpact | ...      |

## Risk Register

| ID  | Decisions | Surfaces | Evidence | Trigger | Failure mode | Consequence and materiality |
| --- | --------- | -------- | -------- | ------- | ------------ | --------------------------- |
| R1  | D1        | ...      | ...      | ...     | ...          | ...                         |

## Risk Characterization

| Risk | Current rating, exposure, uncertainty, and basis | Detectability and signal | Reversibility | Blast radius | Current controls | Required controls | Residual rating, assumptions, and uncertainty |
| ---- | ------------------------------------------------ | ------------------------ | ------------- | ------------ | ---------------- | ----------------- | --------------------------------------------- |
| R1   | ...                                              | ...                      | ...           | ...          | C1 or None       | C2                | ...                                           |

## Control Coverage

| Risk | Prevention                                                       | Detection | Containment | Recovery |
| ---- | ---------------------------------------------------------------- | --------- | ----------- | -------- |
| R1   | C1, NotApplicable: reason, Missing: need, or PendingDecision: R1 | ...       | ...         | ...      |

## Control Ledger

| ID  | Risks | Status               | Kind                                            | Obligation | Ownership class                                               | Owner | Delivery phase                                                          | Verification target         | Evidence |
| --- | ----- | -------------------- | ----------------------------------------------- | ---------- | ------------------------------------------------------------- | ----- | ----------------------------------------------------------------------- | --------------------------- | -------- |
| C1  | R1    | Existing or Required | Prevention, Detection, Containment, or Recovery | ...        | CurrentTicket, RequiredEnablingSeam, or DownstreamTicket:<id> | ...   | Design, Structure, Implementation, BeforeExposure, Runtime, or Recovery | V1 and observable assertion | ...      |

## Verification Plan

| ID  | Risks and controls | Claim and boundary | Method and rationale                                                                                                                                         | Pass evidence | Owner and phase | Automation gap   |
| --- | ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------- | ---------------- |
| V1  | R1; C1             | ...                | StaticRule, FocusedTest, ComponentIntegration, InterfaceContract, SystemTest, OperationalProbe, MonitoringAssertion, RecoveryDrill, or HumanJudgment: reason | ...           | ...             | None or evidence |

## Residual Risk and Decisions

| Risk | Assumed controls | Residual rating and basis | Materiality             | Decision status                                      | Decision owner and evidence |
| ---- | ---------------- | ------------------------- | ----------------------- | ---------------------------------------------------- | --------------------------- |
| R1   | C1, C2           | ...                       | Material or NonMaterial | NonMaterial, AcceptedForThisDesign, or NeedsDecision | ...                         |

## Excluded Speculation

| Candidate | Why considered | Missing evidence link | Disposition |
| --------- | -------------- | --------------------- | ----------- |
| ...       | ...            | ...                   | Excluded    |

## Human Risk Decision

None.
```

Use `None.` in Risk Register only when the complete trace finds no evidence-backed
material failure mode. Use `None.` in Excluded Speculation only when no candidate was
excluded. For `NeedsRiskDecision`, replace `None.` with exactly one answerable question
that names the Design revision, all affected `R*` IDs, the tradeoff, available options,
and the decision owner. The reviewer records an existing acceptance only when evidence
binds that authority to this exact Design and residual risk.

## Verdict rules

Apply the first matching rule. Scores and bands do not appear in these predicates.

1. `ReviseDesign` when an evidence-backed material failure mode is best removed or
   reduced by changing an exact Design decision; the Design lacks or contradicts a
   required invariant, interface, observability mechanism, recovery path, release guard,
   or control obligation; or a current-ticket control lacks a disposition that Design
   must supply. Preserve other findings, but a new Design revision invalidates this
   report.
2. `NeedsRiskDecision` when no Design revision is currently justified and a material
   residual tradeoff lacks an accepted decision for this exact Design, or unavailable
   evidence leaves material uncertainty requiring a human choice to obtain evidence,
   prevent exposure, defer, or accept the stated uncertainty. Ask one answerable human
   question.
3. `ImpactReady` when every required source is `Examined` or `ConfirmedAbsent`; every
   decision and surface is accounted for; every material risk has complete owned control
   dispositions; every required control has a phase and `V*` verification; downstream
   controls have explicit ownership and safe sequencing; every residual risk is
   nonmaterial or has an accepted decision for this exact Design; and no Design change
   is required.

`ImpactReady` means ready for the human Design gate. It does not mean risk-free, approve
the Design, or accept residual risk.

## Completeness checks

The report is complete only when:

- Subject binds the exact ticket, Design, ownership report, authoritative review binding,
  source set, workflow Generation, and policy revision;
- the review binding names the exact ownership report identity and digest and was
  examined rather than reconstructed from report contents;
- Source Inventory contains every required input and cited source;
- every material Design statement maps to one `D*` and every `D*` has all eight surface
  rows;
- every child `D*` resolves to its source decision, and implementation details with the
  same outcome, surfaces, and owner remain together;
- every `NoMaterialImpact` row cites positive evidence;
- every `R*` has the complete evidence chain, characterization, current and residual
  rating state, and linked controls;
- every exact score came from matrix `5x5-v1`, retains both axes, and states uncertainty;
- exact axes cite evidence for their anchors and current and residual likelihood use the
  same exposure basis;
- every `R*` considers all four control kinds;
- every `Missing` or `PendingDecision` disposition names the gap without a fabricated
  `C*`, owner, or verification obligation;
- every required `C*` has one owner, ownership class, delivery phase, verification
  target, and `V*` reference;
- every downstream control names its ticket and safe sequence before exposure;
- every material `R*` and required `C*` maps to at least one complete `V*` obligation;
- every `V*` proves a named control or assumption, combines compatible claims, and stays
  at verification-obligation level rather than becoming an implementation test plan;
- unavailable evidence creates no control ownership absent authority in the ticket,
  ownership report, Design, or issue graph;
- every ID is unique, every reference resolves, and IDs remain in source order rather
  than severity order;
- unsupported candidates have no `R*`, score, or control obligation; and
- the Verdict section contains only the selected verdict token.
