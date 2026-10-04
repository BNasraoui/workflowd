---
name: rpi-coordinate
description: Runs the RPI loop (questions → research → plan → human approval → implement → review) for a Beads ticket. Use when asked to take a ticket through RPI, or when a finished RPI stage arrives in its caller mailbox. Dispatches each stage as a fresh workflowd run and stops for human approval after the plan.
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
- Do not send `parent_session_id`, `parent_kind`, `parent_directory`, `parent_host`, or
  `resume_prompt`. Keep the receipt's `mailbox_id`.

A refusal comes back with a reason; fix that cause and dispatch again. Then wait in the way
your session supports.

### Claude Code with the workflowd channel

Use this path when the session was started with
`--dangerously-load-development-channels server:workflowd` and `dispatch_agent` comes from
that `workflowd` server: its receipt ends with "the result arrives as a channel event; end
your turn". End your turn. The stage's terminal message arrives in this session as
`<channel source="workflowd" run_id="…" mailbox_id="…" status="…">` whose body is the
mailbox message JSON. Do not start the waiter and do not poll. The channel refuses
`parent_*` and `resume_prompt` because this session is live.

### Any other session

After the receipt, start `scripts/wait-mailbox.sh <mailbox_id>` from this skill directory as
a background command, save its output path, and end your turn. For example:

```bash
output=$(mktemp /tmp/rpi-mailbox.XXXXXX)
nohup /path/to/rpi-coordinate/scripts/wait-mailbox.sh "$mailbox_id" >"$output" 2>"$output.err" </dev/null &
```

Use the installed skill's actual path in place of `/path/to/rpi-coordinate`. The waiter uses
`WORKFLOWD_MCP_URL` or defaults to `http://127.0.0.1:8791/mcp`, the repo's loopback MCP endpoint.
It uses `WORKFLOWD_MCP_TOKEN` or `~/.config/workflowd/mcp-token`. An optional second argument
bounds the wait in seconds. Do not poll from this session.

## When the mailbox message arrives

Read the channel event's body, the waiter's JSON output, or call `read_agent_mailbox` with the
saved `mailbox_id`. The first mailbox message is the flat terminal result: `run_id`, `session_id`,
`native_session_id`, `route`, `model`, `executor`, `status`, `end_reason`, `ended_at`,
`final_message`, and `final_message_ref`. A completed run has `status == "completed"`.
The first line of `final_message` is the stage's gist URL. If `final_message` is null,
`final_message_ref` is the native session id; report that the final text is unavailable and
give that reference to the human. If the waiter failed, read its stderr and report the error.

1. If `status` is not `completed`, or the first line of `final_message` is not a gist URL,
   report the failure and the stage's message to the human. Stop. When the text is unavailable,
   report `final_message_ref` instead.
2. Confirm the bead agrees: `bd dolt pull`, then `bd show <id> --json` has the stage's note and the state from the
   table.
3. Dispatch the next stage with only the inputs in the table.

After the plan stage, stop. Show the human the plan gist URL, the phase titles, and any
**Decisions for the reviewer**. Dispatch `rpi-implement` only after the human explicitly
approves that plan. Then record the approval first:
`bd note <id> "plan approved: <plan gist url>"` and `bd dolt push`. If the human chose among the plan's
**Decisions for the reviewer**, append their choices to that note and to the implement
prompt. If the human asks for changes, dispatch `rpi-plan` again with their feedback added
to the prompt, and wait for approval again.

If implement stops and reports a missing file, a wrong Rule, or a plan gap, bring it to the
human; do not widen the plan yourself. After implement, dispatch `rpi-review`. When review
finishes, give the human the verdict, the findings gist, and the PR URL.
