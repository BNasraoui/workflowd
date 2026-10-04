---
name: rpi-coordinate
description: Runs the RPI loop (questions → research → plan → human approval → implement → review) for a Beads ticket. Use when asked to take a ticket through RPI, or when woken by workflowd with a finished RPI stage. Dispatches each stage as a fresh workflowd run and stops for human approval after the plan.
---

# RPI coordinate

You run the loop; you do not do the stages. Each stage runs in a fresh session that sees only
the previous stage's document. Never paste the ticket into a research prompt, and never do a
stage's work yourself.

| Stage | Skill           | Input in the prompt                 | Bead state after |
| ----- | --------------- | ----------------------------------- | ---------------- |
| 1     | `rpi-questions` | bead id                             | `questions`      |
| 2     | `rpi-research`  | questions gist URL only             | `research`       |
| 3     | `rpi-plan`      | bead id and research gist URL       | `plan-review`    |
| —     | human           | plan gist URL                       | approval note    |
| 4     | `rpi-implement` | approved plan gist URL              | `implementing`   |
| 5     | `rpi-review`    | PR URL and plan gist URL            | `review`         |

## Dispatch a stage

Call the workflowd `dispatch_agent` MCP tool once per stage:

- `repository`: the ticket's repository; `route` or `model` as the user chose (ask once if
  unknown, then reuse).
- `prompt`: `Use the <skill> skill. Input: <inputs from the table>.` Add nothing else about
  the ticket.
- `idempotency_key`: `rpi-<id>-<stage>-<attempt>`, so a retried call does not start twice.
- Parent fields, so the stage's end wakes you:
  - Claude Code: `parent_kind: "claude"`, `parent_session_id: $CLAUDE_CODE_SESSION_ID`,
    `parent_directory`: the directory this session started in, `parent_host`: this host's
    name when it is not the daemon host.
  - OpenCode: `parent_session_id`: your session id (`ses_...`); `parent_kind` defaults to
    `opencode`.
- `resume_prompt`: `RPI <stage> finished for <id>. Continue with the rpi-coordinate skill.`

A refusal comes back with a reason; fix that cause and dispatch again. After the receipt, end
your turn. Do not poll.

## When woken

The wake carries the stage's final message in `terminal.final_message` (or a reference in
`final_message_ref`). Its first line is the stage's gist URL.

1. If `terminal.status` is not a success, or the first line is not a gist URL, report the
   failure and the stage's message to the human. Stop.
2. Confirm the bead agrees: `bd show <id> --json` has the stage's note and the state from the
   table.
3. Dispatch the next stage with only the inputs in the table.

After the plan stage, stop. Show the human the plan gist URL, the phase titles, and any
**Decisions for the reviewer**. Dispatch `rpi-implement` only after the human explicitly
approves that plan. Then record the approval first:
`bd note <id> "plan approved: <plan gist url>"`. If the human chose among the plan's
**Decisions for the reviewer**, append their choices to that note and to the implement
prompt. If the human asks for changes, dispatch `rpi-plan` again with their feedback added
to the prompt, and wait for approval again.

If implement stops and reports a missing file, a wrong Rule, or a plan gap, bring it to the
human; do not widen the plan yourself. After implement, dispatch `rpi-review`. When review
finishes, give the human the verdict, the findings gist, and the PR URL.
