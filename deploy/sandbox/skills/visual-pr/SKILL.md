---
name: visual-pr
description: Write the sandbox PR description using the visual review template, then pass it as body to submit_result.
---

# Describe a Pull Request

Describe the result for the current sandbox task with a concise description that helps a reviewer understand why the change exists and the shape of the implementation.

## Workflow

1. Read the description template:

   `Read({SKILLBASE}/references/pr_description_template.md)`

2. Gather only the context needed to explain the change:
   - Read the ticket and any relevant task artifacts.
   - Read the complete local diff against the task source and enough surrounding code to understand behavior and ownership.
   - Read `{SKILLBASE}/references/show-me.md` for the visual-outline conventions used in the PR body.

3. Write the PR description using the template:
   - Keep **Why the change** to exactly one sentence.
   - Keep **Special things to note** to 1-3 bullets. Prioritize reviewer warnings, migrations, compatibility constraints, deliberate omissions, or surprising decisions. Write `- None.` when there are no special considerations.
   - Make **Change outline** a compact, `/show-me`-inspired structural view rather than prose or a file-by-file changelog.
   - Include only the views that help explain this PR:
     - SQL table and endpoint contract changes, plus pseudocode for business logic.
     - key data structure / type changes
     - A shallow file tree showing changed responsibilities.
     - React component tree changes, including important hooks, state, and package boundaries.
     - Call-tree, call-stack, control-flow, or data-flow changes.
   - Prefer `diff` blocks when showing changes to an existing shape. Show the complete target shape when most of it is new or diff notation would obscure ownership or order.
   - Keep each view focused on what a reviewer needs. Omit categories that did not change.
   - optionaL: if you are aware of a ticket id/url, a humanlayer task url, or related plan/document urls, or other relevant links, include them in the header, otherwise omit the header

4. Submit the description as the required `body` argument to `submit_result`, together with `environmentId`, `branch`, `title`, and `commitMessage`.
   - Read skills and supporting files through container-use inside the environment. `{SKILLBASE}` means `/opt/workflowd/skills/visual-pr`.
   - The body must be non-empty GitHub Markdown, at most 32 KiB of UTF-8, with valid Unicode. Only newline is allowed among control characters; Unicode format characters are forbidden.
   - Do not include raw HTML or `<`, `@` mentions, or the GitHub closing words close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved (case-insensitive, even in code examples). Rephrase these words and use fenced code or Mermaid instead of HTML.
   - A rejected submission returns a tool error; correct the body and resubmit. The publisher adds its own marker and opens the draft PR.

Always read and follow `{SKILLBASE}/references/pr_description_template.md`. Do not expand the PR body beyond that template.

Write as one human talking to another: avoid jargon and slang, and use simple, coherent, concise language.

Adapted from [HumanLayer visual-pr](https://github.com/humanlayer/skills/tree/653b6411c1f70c275a18e37673b042ff99f67ceb/plugins/visual-pr/skills/visual-pr), MIT, Copyright (c) 2026 HumanLayer. See LICENSE.
