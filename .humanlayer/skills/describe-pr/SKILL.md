---
name: describe-pr
description: Generate PR Description in CI (no user input)
---

# Generate PR Description

You are tasked with generating a comprehensive pull request description and creating a PR using the repository's standard template with rich linking and deviation analysis.

## Steps to follow:

1. **Read the PR description template:**

   `Read({SKILLBASE}/references/pr_description_template.md)`

2. **Identify or create the PR to describe:**
   - Check if the current branch has an associated PR: `gh pr view --json url,number,title,state,headRefName 2>/dev/null`
   - If a PR exists for the current branch, use that PR and continue to step 3.
   - If no PR exists for the current branch, inspect the current branch/worktree before asking the user:
     - Check current branch and worktree state: `git status --short --branch`
     - If the current branch contains the task implementation, create the PR for the current branch. Do **not** stop after listing open PRs and do **not** ask which PR to use.
     - If there are uncommitted implementation changes that belong to this task, commit them first using the repository's normal git safety protocol, then push the branch and create the PR.
     - If the branch has commits but no upstream/PR, push the branch with `git push -u origin <current-branch>` and create the PR.
   - Only list open PRs with `gh pr list --limit 10 --json number,title,headRefName,author` and ask the user to select one when the current branch does not contain relevant work and there is no safe current-branch PR to create.

3. **Gather PR metadata:**
   - Get PR info: `gh pr view {number} --json url,number,title,state,baseRefName,headRefName,commits,files`
   - Get repo info: `gh repo view --json owner,name`
   - Store the PR URL for diff link generation

4. **Discover task directory and ticket:**
   - Get branch name from PR: extract `headRefName` from step 2
   - Extract task slug (strip prefix before `/`, e.g., `dexter/eng-2612-feature` -> `eng-2612-feature`)
   - Extract ticket ID (e.g., `ENG-2612` or `LL-25` from the slug)
   - Check for task directory: `ls -La .humanlayer/tasks/ | grep -i "{ticket-id}"`
   - Get ticket URL: check `ticket.md` for ticket URL
       - If no URL found, skip — this is fine
   - If task directory exists, set `TASK_DIR`
   - Note: Task-level cloud URLs (artifacts page + deep link) are automatically provided when this skill is invoked via the Skill tool hook. Use these for the header links in the template.

5. **Gather comprehensive PR information:**
   - Get full PR diff: `gh pr diff {number}`
   - Read through the entire diff carefully
   - For context, read any files referenced but not shown in the diff
   - Understand the purpose and impact of each change
   - Identify user-facing changes vs internal implementation details

6. **Generate the PR walkthrough HTML artifact:**
   - **First, decide whether a walkthrough is warranted.** Small PRs are faster to read than a generated walkthrough, so skip this step entirely when the diff is small:
     - Measure the diff size: total changed lines (additions + deletions) and number of changed files. Use the metadata you already gathered (`commits`/`files` from step 3) or count from the diff: `gh pr diff {number} | grep -c '^[+-]'` for changed lines and the length of the `files` array for file count.
     - **If the diff is under 300 changed lines OR touches fewer than 5 files, skip the walkthrough.** Do not generate or write `pr-walkthrough.html`, and do not run the diff-injection script. Continue to step 7; in step 9 omit the walkthrough permalink from the header links (there is no walkthrough to link).
     - Otherwise (300+ changed lines and 5+ files), generate the walkthrough as described below.
   - Read the example: `Read({SKILLBASE}/references/pr_walkthrough_example.html)`
   - Based on your review of the full diff in step 5, generate an interactive PR walkthrough following the example's patterns:
     - Intro card narrating the change top-to-bottom, with headline stats (before/after metrics, diff size, tests passing, commit sha)
     - A collapsible tree of nodes ordered: problem/context → operating principles → numbered steps (one per phase of the work) → "deliberately NOT changed" → verification & ship
     - Badge each node (`step`/`why`/`principle`/`new`/`rewritten`/`modified`/`deleted`/`kept`/`verify`/`ship`) and give it a one-line summary plus an expanded body
     - Use before/after code pairs (the `.ba` structure) for the most important changes; use real snippets from the diff, not placeholders
     - Link every file node into the GitHub PR's "Files changed" view via its `diff` field: `{pr_url}/files#diff-{sha256(file_path)}`. GitHub's per-file anchor is the SHA-256 of the file path — compute all of them in one pass:
       ```bash
       for f in path/to/a.ts path/to/b.ts; do printf '%s  %s\n' "$(printf '%s' "$f" | shasum -a 256 | cut -d' ' -f1)" "$f"; done
       ```
       Use `printf '%s'`, **not** `echo` — the trailing newline changes the hash. Append `R{line}` to deep-link a specific new-side line (`L{line}` for the old side), e.g. from `<a>` links in node bodies next to code snippets
     - Inline the real diff in every file node so reviewers read the change in place. Set `diffFile: "<path>"` on each file node, leave the `#diffs` stash near the bottom of `<body>` **empty** (`<div id="diffs" hidden>\n</div>`), then fill it deterministically with the helper script — do **not** hand-paste hunks (that streams thousands of diff tokens through context just to write them to a file, and the escaping is easy to get wrong):
       ```bash
       {SKILLBASE}/scripts/inject-walkthrough-diffs.sh <walkthrough.html> [base-dir] --pr {number}
       # or, from a checked-out branch instead of a PR number:
       {SKILLBASE}/scripts/inject-walkthrough-diffs.sh <walkthrough.html> [base-dir] --range main...HEAD
       ```
       It fills the stash from every `diffFile:` path in the NODES; re-run it freely after editing nodes, and don't hand-edit the stash. If you are working across multiple repos, run it once per PR with the matching `base-dir`. Pass `--max-lines N` to truncate a huge generated/lockfile-style hunk
     - **IMPORTANT — after running the script, you MUST use the `Read` tool to read the first line of the walkthrough file** (e.g. `Read(path, limit=1)`). The script edits the file on disk directly; the artifact store does not notice writes it didn't make through the tools, so this `Read` is what re-syncs the injected file to the cloud. Skip it and the cloud copy keeps the empty stash
     - Include a "Deliberately NOT changed" section explaining restraint a reviewer might otherwise question
     - Scale node count to the size of the PR — a small PR needs only a handful of nodes
   - Write it to the task directory: `.humanlayer/tasks/{task-dir}/pr-walkthrough.html` (or `.humanlayer/tasks/pr-{number}/pr-walkthrough.html` if no task directory exists)
   - Capture the cloud permalink from the hook response after writing — you will link it from the PR description in step 9

7. **Analyze for plan deviations (if plan file exists):**
   - Check if task directory has a plan file: `ls -La .humanlayer/tasks/{task-dir}/*plan*.md 2>/dev/null`
   - If plan file exists, use the Task tool with `subagent_type=implementation-reviewer`:
     ```
     Analyze deviations between the plan at .humanlayer/tasks/{task-dir}/{plan-file}
     and the current implementation. Compare against the base branch.
     ```
   - Include the agent's output in the "Deviations from the plan" section

8. **Determine output path:**
   - If task directory exists: `.humanlayer/tasks/{task-slug}/pr-description.md`
   - If no task directory: `.humanlayer/tasks/pr-{number}/description.md`

9. **Generate the description:**
   Fill out each section from the template:
   - **Header links**: Include ticket link, artifacts cloud URL, task deep link (provided automatically via hook when this skill was invoked), and the PR walkthrough cloud permalink from step 6 (omit this link when step 6 skipped the walkthrough for a small diff)
   - **What problems**: Based on ticket/plan context and code changes
   - **What user-facing changes**: Bulleted list with diff permalinks from step 5
   - **How I implemented it**: Journey through the PR with file/line permalinks
   - **Deviations from plan**: Include agent output from step 7 (or "No plan file found")
   - **How to verify it**: Include worktree setup commands with actual branch name
   - **Changelog entry**: Concise one-line summary

10. **Save the description:**
    - Write the completed description to the path from step 8
    - A cloud permalink will be automatically provided in the hook response
    - Show the generated description

11. **Create the PR if it does not already exist**
    - Always read the template from `{SKILLBASE}/references/pr_description_template.md`
    - If step 2 already found or created a PR, skip creation here and use that PR.
    - If no PR exists yet, create it with the `gh` CLI: `gh pr create --base <default branch> --head <current branch> --title <concise title>`
    - A missing PR is not, by itself, a reason to stop. Create the PR for the current task branch whenever the branch/worktree clearly contains the work being described.

12. **Update the PR:**
    - Update PR: `gh pr edit {number} --body-file {output-path}`
    - Confirm the update was successful

13. **Update the user:**
    - Read key artifacts (ticket file, research, design discussion, structured outline, plan) using the `Read` tool but only read a few lines NOT the entire artifact - this will give you the cloud URLs for each of them.
    - Read the final output template:
      `Read({SKILLBASE}/references/describe_pr_final_answer.md)`
    - Respond with a summary following the template, including the PR URL and key details including `RPI_TASK_ARTIFACTS_URLS` as the URLS you obtained by reading the artifacts

## Important notes:
- Always read the template from `{SKILLBASE}/references/pr_description_template.md`
- The PR walkthrough HTML (step 6) is built from your own review of the diff — write it before the deviation analysis so the walkthrough reflects what the code does, not what the plan said
- Use the `implementation-reviewer` agent for deviation analysis when a plan exists
- Focus on the "why" as much as the "what"
- Include breaking changes or migration notes prominently

Remember, you must respond to the user according to the output template at `{SKILLBASE}/references/describe_pr_final_answer.md`
