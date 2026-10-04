---
name: rpi-questions
description: First RPI stage. Use when given a Beads ticket id to start a Research → Plan → Implement loop. Turns the ticket into 2–8 neutral questions about how the code works today, so a fresh research session can survey the code without knowing the planned change.
---

# RPI questions

You turn a ticket into questions. The next stage, research, sees only your questions, never
the ticket. If your questions reveal the change, research will start designing it instead of
describing the code. Your job is to hide the goal and point at the right code.

## Steps

1. Read the ticket: `bd show <id> --json`. Note every path, symbol, URL, and command it names.
2. Read just enough code to find where the ticket's area lives: entry points, the modules
   involved, and how they connect. Stop when you can name the files to ask about. Do not
   trace everything; research does that.
3. Write 2–8 questions about how the code works **today**. Good shapes:
   - "How does a webhook delivery reach the job store? Trace the call path."
   - "Where is the retry delay for failed jobs decided, and what inputs does it use?"
   - "Which tests exercise `src/worker.ts`, and which end-to-end harnesses run it?"
4. Check each question against the ticket. Rewrite any that names the new behavior, a
   proposed design, or a judgement. Never ask "how would we add Z", "where should Z go",
   "what is wrong with X", or "what is missing from X". If the ticket says "add backoff to
   retries", ask how retries are scheduled today; do not mention backoff.
5. Copy the ticket's pointers into a **Pointers** list verbatim: paths, symbols, URLs. Do not
   copy the ticket's goal, title, or acceptance criteria.
6. If the repository has `.provenance/`, add questions about the graph near the area, for
   example: which Requirements and Rules govern `<area>`, which Rules bind `<files>`, and
   which Topics are open under those Requirements.

## Document

Write the document outside the repository, at `/tmp/rpi/<id>/questions.md`:

```markdown
# RPI questions: <id>

Repository: <owner/repo> at <commit sha>

## Pointers

- <verbatim path, symbol, or URL from the ticket>

## Questions

1. <question about today's code>
```

## Publish

1. `gh gist create --desc "RPI questions <id>" /tmp/rpi/<id>/questions.md` prints the gist URL.
   Gists are secret by default; never pass `--public`.
2. `bd note <id> "questions: <gist url>"`
3. `bd set-state <id> rpi=questions --reason "questions published"`
4. Do not commit anything. Your final message starts with the gist URL on its own line,
   followed by one sentence naming the areas the questions cover.
