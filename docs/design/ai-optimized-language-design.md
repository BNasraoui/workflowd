---
type: design-discussion
repo: BNasraoui/workflowd
branch: claude/ai-optimized-language-design-92pvzt
status: draft
revision: 1
---

# AIython: a language optimised for machine authorship, automated validation and deterministic execution

## Summary

Every mainstream language so far has been designed around the cost of a human writing and
reading it. That cost function is changing. When most code is generated and reviewed by language
models, the scarce resources are no longer keystrokes and eyeball time. They are:

- the probability that a generated program is valid and means what the spec says;
- the cost of proving or disproving that automatically;
- the ability to reproduce any execution exactly.

This document extrapolates the historical trend to a language whose canonical form is not meant
for humans at all. The working name is **AIython**. Its source of truth is a canonical typed tree,
not text. Its grammar is designed for constrained decoding, so a model cannot emit a syntax error.
Its type system makes contracts, effects and termination part of every signature, so most of what a
reviewer checks today is discharged by a checker. Its runtime semantics are fully specified, so any
run can be replayed bit for bit. An external compiler, in the spirit of Cython, lowers it to C and
produces a read-only human projection on demand.

The rest of this document explains the trend, the design principles, the language, the toolchain,
a worked example, what changes for review, the costs, and a staged adoption path.

## 1. The progression so far

Each generation of language moved work from the human to the machine and paid for it with machine
resources that had become cheap.

| Era | Language | What the human still did | What the machine took over | Resource spent |
| --- | --- | --- | --- | --- |
| 1950s | Machine code, assembler | Register allocation, addressing, control flow | Nothing | None |
| 1970s | C | Memory management, bounds, type discipline | Register allocation, calling conventions, portability | CPU cycles for the optimiser |
| 1990s | Java, C# | Structuring programs around types, explicit declarations | Memory management, memory safety, platform ABI | RAM and CPU for the garbage collector and VM |
| 2000s | JavaScript, Python | Intent, in near-prose form | Types, layout, dispatch, most performance decisions | JIT compilers, orders of magnitude of runtime |

Two things to notice.

First, the direction is monotone: each step deleted a category of human work and accepted a
machine cost that a decade earlier would have been unaffordable.

Second, every step optimised the same thing, the human authoring and reading experience. Python's
success is almost entirely a story about readability and low authoring friction. Dynamic typing,
significant whitespace, duck typing and exceptions are all bets that a human will find the code
easier to write and follow. Each of those bets makes automated validation harder.

## 2. The cost function has changed

When a model writes and another model reviews, the relevant properties of a language are different.

**Authorship is token generation.** A model emits a program left to right, one token at a time,
with no backspace. Every token where the set of valid continuations is large and the set of
correct continuations is small is a place where errors enter. Human-oriented languages are full of
such places: free-form identifiers, implicit conversions, operator precedence, optional semicolons,
overloaded names, and syntax that only becomes wrong many lines later.

**Reading is whole-context ingestion.** A model does not benefit from terseness the way a human
does. It benefits from locality and explicitness: everything a piece of code depends on is visible
near it, nothing happens implicitly, and no hidden state changes the meaning of a call. Syntactic
sugar and clever abstractions save human keystrokes but cost the model context and inference.

**Validation must be mechanical.** If a human is not going to trace the code, then correctness has
to be established by tools. That means the language must make the interesting properties
expressible and checkable: what a function requires, what it guarantees, which effects it can
perform, whether it terminates, and whether an optimised version agrees with an obvious one.

**Execution must be reproducible.** A model in a repair loop needs a failing run to be a fact, not
a probability. Undefined behaviour, unspecified evaluation order, address-dependent hashing,
ambient clocks and random sources all turn a bug into a heisenbug.

A language built for this cost function will look nothing like Python. It does not need to. Humans
will still need to read it sometimes, and that is a projection problem, not a syntax problem.

## 3. Design principles

1. **The canonical form is a tree, not text.** Programs are stored and hashed as a canonical
   encoding of a typed abstract syntax tree. There is exactly one encoding of any program. Textual
   serialisations exist for transport and for the generation protocol, but they are not the source
   of truth.
2. **Every prefix of a valid program is a valid partial program.** The grammar and the type system
   are designed so that an incomplete program is typeable, with typed holes where the rest goes.
   The checker can tell a generator exactly what may come next.
3. **Nothing is implicit.** No implicit conversions, no operator overloading, no inheritance, no
   exceptions, no null, no global mutable state, no ambient input or output. Every dependency of a
   function is a parameter.
4. **Contracts are part of the type.** Preconditions, postconditions, effect sets and termination
   status are in every signature. Calling a function is an obligation, and obligations are
   discharged by the checker or explicitly deferred, never ignored.
5. **Execution is fully specified.** Every operation has one defined result on every input on every
   platform. Nondeterminism exists only behind explicit capabilities, and those capabilities are
   recordable and replayable.
6. **Definitions are content-addressed.** A definition's identity is the hash of its canonical
   tree. Names are metadata. Dependencies are exact hashes. Verification results are cached by hash
   and never repeated for an unchanged definition.
7. **Diagnostics are data.** The compiler never emits prose. It emits structured records with node
   identities, failed obligations and counterexamples, designed to be consumed by the next
   generation step.
8. **Humans read projections.** A human-readable view is generated from the canonical form in a
   familiar syntax. Humans review specs and projections. They do not edit the canonical form.

## 4. The language

### 4.1 Canonical form and serialisation

The unit of storage is a definition: a signature, an optional oracle reference, a body, and a hash
computed over the canonical encoding of the signature and body. The encoding is a deterministic
binary tree format (fixed node tags, fixed field order, length-prefixed children, no padding, no
comments, no whitespace). Two programs with the same meaning modulo local variable naming have the
same encoding because local variables are positional, not named.

For transport, logging and the examples in this document, there is a canonical text form. It is an
S-expression syntax with a small fixed vocabulary. It is not designed to be pleasant. It is
designed so that the tokenizer is trivial, the grammar is LL(1), and every token position has a
computable set of admissible next tokens.

```lisp
(def
  (sig (fn ((xs (Array U32)) (target U32)) (Option (Index xs)))
    (requires (sorted xs))
    (ensures r
      (case r
        ((Some i) (= (at xs i) target))
        (None (not (contains xs target)))))
    (effects ())
    (total))
  (oracle @array.linear-search)
  (body
    (loop ((lo (U32 0)) (hi (len xs)))
      (measure (- hi lo))
      (invariant (<= lo hi) (<= hi (len xs))
        (forall j (Index xs) (implies (< j lo) (< (at xs j) target)))
        (forall j (Index xs) (implies (>= j hi) (> (at xs j) target))))
      (if (= lo hi)
        (break None)
        (let ((mid (+ lo (/ (- hi lo) (U32 2)))))
          (case (cmp (at xs mid) target)
            (Less (continue (+ mid (U32 1)) hi))
            (Greater (continue lo mid))
            (Equal (break (Some mid)))))))))
```

Observations about this form:

- There are no user-chosen names inside the body. `lo`, `hi`, `mid` and `j` are binder positions.
  The text form shows labels for readability, but the canonical encoding stores only de Bruijn
  indices. A human label table lives in sidecar metadata keyed by the definition hash.
- `@array.linear-search` is a name reference resolved to an exact hash at commit time. The
  canonical form stores the hash. The text form may show either.
- `(Index xs)` is a refinement type: an unsigned integer provably less than `(len xs)`. The call to
  `at` therefore has no bounds check and no failure case.
- The loop carries its own termination measure and invariants. They are not documentation. The
  checker uses them.

### 4.2 Vocabulary and identifiers

The token vocabulary is closed and small: a few hundred keywords and node tags, integer and string
literals with explicit type tags, binder indices, and definition references. This matters for
constrained generation. A decoder that knows the grammar and the current typing context can mask
the model's output distribution to admissible tokens only, so syntax errors and most binding errors
are impossible by construction.

References to existing definitions are the one place a large open vocabulary appears. The
generation surface accepts qualified names, which the toolchain resolves against the workspace
and rejects if ambiguous. The canonical form stores hashes. The model is given the relevant slice
of the symbol table in context: hash, label, signature and a short description for each definition
it might reasonably use.

### 4.3 Types, effects and contracts

The type system is a conservative combination of ideas that already exist and have been tested in
research or niche production languages. Nothing here is novel. What is different is making all of
it mandatory in the default mode.

**Total by default.** Every function terminates. Recursion must be structural or carry a measure.
Loops carry a measure. A function that cannot be shown total must be marked `(partial)`, and
partiality propagates to every caller's signature. Whole-program totality is then a single grep.

**No null, no exceptions.** Absence is `Option`. Failure is `Result` with an explicit error type.
There is no nonlocal control flow other than returning a value.

**Fixed-width arithmetic with no undefined behaviour.** `U32`, `I64`, `F64` and friends have
exactly the semantics of the IEEE and two's-complement standards with all rounding modes fixed.
Plain `+` on integers is admissible only when the checker can prove no overflow from the operands'
refinement types. Otherwise the author must choose `+?` (returns `Option`) or `+%` (wraps). There is
no silent promotion between widths and no promotion between integers and floats.

**Effects as capabilities.** A function's signature lists the effects it can perform. An effect is
performed by calling a method on a capability value that was passed in as a parameter. There are
no globals to reach for. A function declared `(effects ())` is pure and the checker enforces it. The
standard capabilities are `Clock`, `Random`, `Fs`, `Net`, `Env` and `Spawn`. Tests inject
deterministic implementations. Production injects real ones at the single entry point.

**Contracts in the signature.** `requires` and `ensures` clauses are first-order formulas over the
parameters and result, drawn from a decidable fragment (linear integer arithmetic, arrays, algebraic
data types, uninterpreted functions). The checker discharges call-site obligations with an SMT
solver. Obligations that fall outside the decidable fragment, or that the solver times out on, are
compile errors unless the author writes an explicit proof term or marks the call `(dyn)`, which
inserts a runtime check and propagates a `MayFail` marker into the signature. Nothing is ever
silently assumed.

**Immutability by default, local mutation only.** Values are immutable. A `(mut ...)` cell is
allocated in a scope and cannot escape it or be captured by a parallel branch. This is enough to
make data races unrepresentable without a full ownership system.

### 4.4 Determinism guarantees

The language specification fixes every observable aspect of execution:

- Evaluation order is left to right, strict, and specified for every node type.
- Integer semantics are as described above. Floating point is IEEE-754 binary64 and binary32 with
  round-to-nearest-even, no fused multiply-add contraction, no fast-math, no extended precision.
- Map and set iteration order is the canonical order of the key type. Hashing of user data is
  seeded with a fixed constant. Memory addresses are never observable.
- Structured parallelism via `(par ...)` runs branches with independent inputs and combines them
  with a deterministic join. Scheduling cannot affect the result.
- Every source of real nondeterminism is a capability. The runtime can record every capability
  response for an execution into a trace and replay the trace against the same or a modified
  program. A failing run is therefore a portable artefact, not a description.
- Compilation is reproducible: the compiled output hash is a function of the program hash and the
  toolchain hash. Two machines produce identical binaries.

### 4.5 Holes and prefix typing

A partial program is a program with typed holes. The text form writes a hole as `(? n)` and the
checker reports its expected type, the binders in scope, the obligations it must satisfy, and the
set of node tags admissible in that position. This is what makes constrained generation practical:
generation becomes a sequence of hole refinements, each of which is checked before the next.

```lisp
(body
  (loop ((lo (U32 0)) (hi (len xs)))
    (measure (- hi lo))
    (invariant (<= lo hi) (<= hi (len xs)))
    (if (= lo hi)
      (break None)
      (? 1))))
```

The checker's answer for hole 1:

```json
{
  "hole": 1,
  "expected": "LoopStep<(U32, U32), Option<Index xs>>",
  "scope": [
    {"idx": 0, "label": "xs", "type": "Array U32"},
    {"idx": 1, "label": "target", "type": "U32"},
    {"idx": 2, "label": "lo", "type": "U32", "facts": ["lo < hi", "hi <= len xs"]},
    {"idx": 3, "label": "hi", "type": "U32"}
  ],
  "must_preserve": ["lo <= hi", "hi <= len xs"],
  "must_decrease": "hi - lo",
  "admissible_heads": ["let", "case", "if", "continue", "break"]
}
```

A generator that respects this answer cannot produce an ill-typed body, cannot break the invariant
without the checker noticing at the next refinement, and cannot write a loop the checker cannot
prove terminates. The point is not that the model is prevented from being wrong about the algorithm.
It is that every way of being wrong is caught at the earliest token where it becomes detectable.

### 4.6 Oracles and equivalence

Models are good at writing the obvious version of a function and less reliable at writing the fast
one. The language makes that division of labour a first-class construct. A definition may name an
`oracle`, a slower reference implementation with the same signature. The checker then has to
establish that the two agree on all inputs satisfying the precondition. It tries, in order:

1. SMT-based bounded equivalence for small input sizes;
2. symbolic execution over the decidable fragment;
3. exhaustive testing for finite input domains;
4. property-based testing with a fixed seed, which is a fallback that downgrades the definition's
   status to `tested` rather than `verified` and records that in the signature.

The status is visible to callers and to review tooling. Reviewers can decide that `tested` is
acceptable for a formatting helper and not for a settlement calculation.

### 4.7 Modules and content addressing

There are no files in the canonical model, only definitions and their hashes. A module is a named
set of hashes. A workspace is a map from labels to hashes plus the sidecar metadata for humans.

Consequences that fall out of this directly:

- Renaming is free and cannot break anything. Names are metadata.
- Dependencies are exact. There are no version ranges, no resolution algorithm, no lockfile
  separate from the code.
- Two definitions with the same body are the same definition. Duplicate code is detected by
  identity, not by heuristics.
- Verification results, test results and compiled artefacts are cached by hash. Changing one
  definition re-verifies that definition and the callers whose obligations mention it, and nothing
  else.
- A diff between two workspaces is a set of added and removed hashes. A semantic diff tool can show
  what changed at tree level and which obligations changed status.

This is the model Unison uses for text-based programs and Nix uses for builds. Applying it to a
language whose only form is the tree removes the last place where textual identity leaks in.

## 5. The toolchain

The Cython comparison is deliberate. Cython takes a restricted, annotated Python dialect, generates
C, and compiles that with the platform toolchain. The Python interpreter never sees the C. The
AIython toolchain, `aiyc`, has the same shape with the canonical tree in place of `.pyx`.

```text
generation protocol            canonical store            projections
(LLM <-> aiyc check)   --->    definitions by hash   --->  aiyc view    (read-only Python-like text)
                                      |
                                      v
                               aiyc verify   (SMT, symbolic, property tests; results cached by hash)
                                      |
                                      v
                               aiyc lower    (canonical tree -> C99 with a small deterministic runtime)
                                      |
                                      v
                               platform C compiler with fixed flags -> reproducible binary
```

**The generation protocol** is a request and response API, not a file format. The generator opens
a session against a workspace, proposes a definition or a hole refinement, and receives structured
results. The core messages are `propose`, `check`, `holes`, `admissible`, `counterexample` and
`commit`. `commit` is refused unless every obligation in the proposed definition is discharged or
explicitly deferred with `(dyn)` or `(partial)`. Nothing enters the store in an unchecked state.

**Diagnostics** are records. A failed postcondition arrives as the node hash of the `ensures`
clause, the concrete input that violates it, the concrete output, and the trace of capability
responses if any. A model repairing the program can act on that directly. A human reading a
projection sees the same record rendered in prose.

**The lowering** to C is unremarkable by design. Fixed-width integers map to `stdint.h` types with
explicit checked or wrapping helpers. Refinement types erase. Contracts marked `(dyn)` become
assertions with structured failure reporting. Capabilities become function-pointer tables passed
explicitly. Structured parallelism lowers to a deterministic fork-join runtime. The C is emitted with
a fixed formatter so it is diffable, and compiled with a pinned toolchain and a fixed flag set to
keep the binary reproducible.

**The view** is the human-facing product. `aiyc view` renders a definition in a Python-like syntax
using the sidecar labels, with contracts as decorators and the verification status in a header.
The example from section 4.1 renders as:

```python
# verified: total, pure, equivalent to array.linear_search (bounded, n <= 64)
@requires(lambda xs, target: sorted(xs))
@ensures(lambda xs, target, r: (r is None and target not in xs) or xs[r] == target)
def binary_search(xs: Array[U32], target: U32) -> Optional[Index[xs]]:
    lo, hi = U32(0), len(xs)
    while lo != hi:  # measure: hi - lo
        mid = lo + (hi - lo) // 2
        match cmp(xs[mid], target):
            case Less:    lo = mid + 1
            case Greater: hi = mid
            case Equal:   return Some(mid)
    return None
```

The view is not editable. Editing it would reintroduce every ambiguity the canonical form removes.
A human who wants a change describes it, and a generator proposes a new tree.

## 6. A worked loop

The following shows one definition moving through the loop from spec to compiled artefact. The
task is a function that merges two sorted arrays.

1. **Spec.** A human or an upstream agent writes the signature only: input arrays sorted,
   output sorted, output is a permutation of the concatenation, pure, total. The checker accepts the
   signature with the body as a single hole.
2. **Oracle.** The generator proposes an oracle: concatenate and sort. The checker verifies the
   oracle against the signature. It passes. The oracle is committed with status `verified`.
3. **Implementation.** The generator proposes a two-pointer merge. The checker discharges
   termination from the measure, discharges the sortedness postcondition, and fails the permutation
   postcondition with a counterexample: when one input is exhausted, the remaining elements of the
   other are dropped.
4. **Repair.** The counterexample names the loop exit node and the concrete inputs
   `[1, 3]` and `[2]`. The generator refines the exit branch to append the remainder. The checker
   passes all obligations and establishes bounded equivalence with the oracle up to length 32.
5. **Commit.** The definition enters the store under its hash with status `verified` for the
   contracts and `equivalent (bounded 32)` for the oracle relation.
6. **Review.** A human reads the projected signature and the status line. They do not read the
   body unless they want to. The review question is whether the spec is the spec they wanted.
7. **Build.** `aiyc lower` emits C. The binary hash is recorded alongside the definition hash. A
   second machine reproduces the same binary from the same two hashes.

No step in this loop involves a human reading an implementation for correctness. The human's job
moved entirely to the specification and the acceptance threshold.

## 7. What changes for review

Today a pull request review does three things at once: it checks that the change does what was
asked, that it is implemented correctly, and that it does not break anything. In this design those
separate cleanly.

- **Does it do what was asked?** This is a spec question and stays with humans. It is asked against
  the projected signature and contracts, which are short.
- **Is it implemented correctly?** This is an obligation status. It is either discharged, tested
  with a stated bound, or deferred with a visible marker. A reviewer reads the marker, not the
  code.
- **Does it break anything?** This is a set difference between two workspaces plus the set of
  callers whose obligations changed status. The tooling computes it exactly.

The review artefact becomes a table of definitions with their status transitions, not a textual
diff. Textual diffs still exist for humans who want them, as projections of a tree diff.

This repository already applies the same instinct at the pull-request level. Workflowd binds every
review to an exact Review Target and supersedes work whenever the head or base identity changes.
AIython pushes the same idea down to the definition: identity is content, and any process that
reasons about a definition reasons about its hash.

## 8. Costs, risks and open questions

**Bootstrapping.** Models are trained on Python and JavaScript, not on this. Early generation
quality in the canonical form will be worse than in Python, and the constrained decoder only
prevents invalid programs, not wrong ones. The adoption path in section 9 addresses this by
starting from a Python dialect and moving the source of truth to the tree only once the tooling
carries its weight.

**Solver cost and brittleness.** SMT solvers time out, and small changes in a formula can flip a
proof from instant to intractable. The design accepts this by making deferral explicit and visible
rather than by pretending the checker always succeeds. It still means some code will carry `(dyn)`
markers for a long time.

**Spec writing is the hard part.** Moving the human's job to specification does not make it
smaller. Writing a postcondition that captures intent is harder than reading a for-loop. Contract
languages have historically stalled here. The mitigation is that models can propose specs from
prose and oracles from specs, so the human's job is closer to accepting than to authoring. Whether
that is enough is an open question.

**Debugging.** A trace that replays exactly is a strong tool, but debugging a tree with positional
binders through a projection is untested territory. The projection has to be good enough that a
human can step through it, which means the sidecar labels have to survive edits well.

**Ecosystem.** Everything useful lives in libraries written in other languages. A foreign function
boundary is unavoidable and every foreign call is an effect with unverified contracts. The design
handles this honestly by giving foreign calls a `(foreign)` status that propagates like
`(partial)`, so the verified core is always distinguishable from the untrusted shell.

**Where the semantic names go.** Models reason better with meaningful identifiers. The canonical
form throws them away. The design keeps them in sidecar metadata and always shows them in the
generation surface, so the model sees names even though the hash does not depend on them. Whether
that is sufficient or whether names should be part of the canonical form after all is the design
decision most likely to be revisited.

**Performance.** Fully specified floating point and checked arithmetic cost real cycles. The
design chooses determinism first and expects the lowering to recover most of it where refinement
types prove checks unnecessary. Anyone who needs fast-math can perform it behind a capability and
accept that the result is not replayable.

## 9. Adoption path

The Cython analogy suggests the path. Cython did not ask anyone to stop writing Python. It let
people annotate the Python they already had and gain something immediately.

**Phase 0: a restricted, annotated Python dialect.** Define the subset of Python that maps cleanly
onto the canonical tree: no exceptions, no inheritance, no globals, explicit capability parameters,
fixed-width numeric types, contracts as decorators. Ship `aiyc` as a checker and lowering tool over
that dialect, exactly as Cython sits over `.pyx`. Models generate the dialect today with no
retraining. Teams gain contracts, effect checking and deterministic builds immediately.

**Phase 1: the tree becomes the source of truth.** Store the canonical tree, derive the Python
text as a projection, and expose the generation protocol. The dialect stays as the human-facing
view and as a fallback input format. Content addressing and result caching start paying for
themselves here.

**Phase 2: generation moves to the canonical form.** Once enough of a corpus exists in the tree
form and the protocol has been exercised, fine-tune or prompt models to generate against the
protocol directly with constrained decoding. The Python view remains for humans and never goes
away.

Each phase delivers something on its own, and each can stop without stranding the previous one.

## 10. What we are not doing

- Designing a new human-friendly syntax. The text form in this document is a transport encoding.
- Replacing existing languages for interactive, exploratory or throwaway work. Notebooks and
  scripts remain a human activity for as long as humans want them.
- Claiming that constrained generation makes models correct. It makes their outputs valid and
  makes their errors detectable earlier and cheaper. Correctness against intent remains a
  specification problem.
- Committing to a specific solver, proof language or lowering target. The design fixes what must be
  true of them, not which ones they are.
