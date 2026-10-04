---
name: rpi-research
description: Second RPI stage. Use when given an RPI questions document (a gist URL or file) to answer. Describes how the code works today with file:line evidence, the governing Provenance graph when present, and the testing patterns per area. Never reads the ticket and never recommends changes.
---

# RPI research

You answer questions about the code as it is. You write a map, not a proposal. The plan
stage relies on your map being factual, so it must not lean toward any change.

## Inputs

Only the questions document: `gh gist view <url> --raw`. Do not run `bd show`, read the
ticket, or search for the ticket's goal. The document names the ticket id; use it only for
the branch name and the bead note.

Never run a command that prints the ticket. Some write commands echo it, so run every `bd`
command with `-q` (quiet) and read only whether it succeeded.

## Start

1. `bd dolt pull -q`.
2. `git fetch origin`, then `git checkout --detach <sha>` with the full SHA from the
   questions document's `Repository:` line. Read the code at that commit.

## Steps

1. For each question, read the code and trace the actual path. Cite every claim as
   `path:line` or `path:start-end` at the commit you read. If you could not confirm
   something, say so instead of guessing.
2. Describe only. Do not write "should", "could be improved", "a better approach", "the
   fix", "we recommend", risks of a change, or next steps. A bug you notice is a fact:
   state what the code does, with evidence, and move on.
3. For each area, add a **Testing** note: which test files cover it, how they build their
   fixtures, and which end-to-end harnesses exist (simulations, fixture repositories,
   containers, spawned processes). Name the command that runs them.
4. If the repository has `.provenance/`, read the graph with the CLI and report what governs
   the area. Check exact flags with `--help` first.
   - `provenance search --text <term>` for Requirements, Rules, and Topics near the area
   - `provenance rules resolve-symbol --file <path>` for Rules bound to each file
   - `provenance coverage scan --path <dir>` for bindings and gaps
   - `provenance traceability <rule-id>` for each Rule that governs the area
   - `provenance topics list` for open Topics
   Report what you found, including "no Rule binds this file".

## Document

Write to `/tmp/rpi/<id>/research.md`, outside the repository:

```markdown
# RPI research: <id>

Questions: <questions gist url>
Repository: <owner/repo> at <full commit sha>

## <question 1, verbatim>

<answer with path:line evidence>

Testing: <tests, harnesses, and how to run them>

## Graph (only with .provenance/)

<Requirements, Rules, bindings, open Topics for the area>
```

## Publish

1. Re-read `/tmp/rpi/<id>/research.md` and fix it before publishing. Then
   `gh gist create --desc "RPI research <id>" /tmp/rpi/<id>/research.md` (secret by
   default). It can exit non-zero after printing the URL; check the output for a gist URL
   before you retry. Get the exact revision with
   `gh api gists/<gist id> --jq '.history[0].version'`; the revision URL is
   `<gist url>/<version>`.
2. Create branch `rpi/<id>` at the commit you read (`git switch -c rpi/<id>`) and push it. Open a draft PR for the
   ticket: `gh pr create --draft --head rpi/<id> --title "RPI <id>"` with the
   gist URL in the body. If the branch has no changes yet, commit with `--allow-empty`.
3. If `.provenance/` exists, record the questions and research gists as Sources on
   `rpi/<id>`: `provenance sources create --id <id>-rpi-questions --name "RPI questions for <id>" --source-type project_artifact --url <revision url>`,
   then the same for research. Commit only the `.provenance/` changes and push.
4. Record both URLs, one per line:
   `printf '%s\n' "research: <gist url>" "pr: <pr url>" | bd -q note <id> --stdin`
5. `bd -q set-state <id> rpi=research --reason "research published"`, then `bd dolt push -q`.
6. Never commit the document itself. Your final message starts with the gist URL on its own
   line, then the draft PR URL.
