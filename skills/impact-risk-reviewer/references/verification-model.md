# Verification model

Verification proves that a risk assumption or control claim holds at its real boundary.
It does not replace prevention, containment, recovery, or an authorized residual-risk
decision.

## Method

For every material risk and required control:

1. State one observable claim tied to its `R*` and `C*` IDs.
2. Select the lowest reliable boundary that can expose failure: static rule, focused
   logic, component or integration, interface or contract, system journey, deployment
   or operational probe, monitoring assertion, or recovery drill.
3. Prefer deterministic automation that an agent can run and grade. Add a higher boundary
   only when a material crossing remains unproved.
4. Define the pass evidence, owner, and phase. Add setup, fault injection, or cleanup only
   when it is necessary to make that control claim checkable.
5. Match evidence to the claim. A successful response does not prove an asynchronous
   effect, a visible control does not prove persisted state, and a log line alone does
   not prove containment or recovery.
6. Use human execution only for an inherently human judgment or an external or physical
   condition that automation cannot reproduce reliably. Record that constraint and the
   smallest human decision or observation needed.

## Verification obligation

Assign stable `V1`, `V2`, ... IDs in risk and control order. Each obligation records:

- covered risk and control IDs;
- the exact claim and boundary;
- method and why it is the lowest reliable method;
- expected observable evidence and pass condition;
- owner and delivery phase;
- any evidence-backed automation gap.

Existing tests or signals count only when their current evidence proves the same claim at
the required boundary. A named test suite, tool, coverage percentage, or dashboard is not
evidence by itself.

## Coverage rule

Every material `R*` and required `C*` maps to at least one `V*`. One obligation may cover
several controls when it produces clear evidence for each claim. Split obligations when
their boundary, owner, setup, or failure diagnosis differs.

The set is a risk-and-evidence map, not a universal test plan. Omit irrelevant layers
with reasons. Keep it proportionate: verification supports the control disposition and
must not decompose implementation, prescribe a general regression suite, or substitute
for prevention, containment, recovery, or a risk decision. Repeated checks with stable
inputs and pass conditions belong in automation; human approval remains a decision gate
rather than a substitute for verifiable evidence.
