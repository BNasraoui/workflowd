---
name: ticket-writing
description: Ticket writing for Beads. Use to create, revise, or translate a ticket, or to review a ticket before QRSPI kickoff.
---

# Ticket writing

Use [`references/ticket-template.md`](references/ticket-template.md) for the shape of a
ticket that will require multistage work (i.e. QRSPI).

## Process

1. Establish whether the ticket will enter QRSPI. Use the full contract only when it will.
   For other work, use the chosen Beads type and the structure the user needs. Done when
   the type, purpose, and permission to write are clear.
2. For an existing ticket, run `bd show <id> --json`. Read and verify each source the user
   supplied and every reference in the ticket's `Sources` section. Follow parent, dependency,
   and dependent IDs with `bd show <related-id> --json` when their scope overlaps the requested
   change. Done when every citation is resolved and the ownership boundaries are clear.
3. For a review-only request, assess the ticket against the readiness rules below, report
   whether it is ready and any missing product details, then stop. Do not draft changes or
   write to Beads.
4. If a missing fact could change the ticket's meaning, ask the user and end the turn.
   Draft only after they answer. Ask about desired behavior and scope; leave implementation
   choices to the coming QRSPI workflow.
5. Write or revise the ticket. Keep its Beads type and the intent found in the user input
   and sources. For QRSPI work, check every readiness rule below. For other work, check the
   user's request.
6. Only when the user explicitly asks to persist changes, write to Beads with `bd create` or
   `bd update`, then run `bd show <id>`. Done when the saved ticket matches the draft.

## QRSPI readiness

A QRSPI ticket is **Ready** when its title names the change, its Description explains the
desired result, its acceptance criteria are observable, and its scenarios make every
criterion concrete.

When another ticket owns downstream behavior that this ticket enables, **Ready** also requires
the Description to name that owner, state the minimal enabling seam retained here, and state
the lifecycle deferred there.

If it is not ready, discuss the missing product details before writing the ticket. User stories,
source lists, and scope lists are optional but optimal. Research, design, planning, task
breakdown, and delivery proof come later.
