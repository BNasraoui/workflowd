---
name: configure-workspaces
description: Interview the user and generate workspace configuration files (.humanlayer/workspace.json and .humanlayer/workspace.local.json) for a repository
---

## Purpose

This skill helps users configure workspace behavior for a repository. It interviews the user, reads context from the project, generates the workspace config files, and validates the configuration.

The workspace config files control how worktrees are created when tasks use `workspaceTiming = now` in the Riptide task creation UI:
- `.humanlayer/workspace.json` — shared team configuration, safe to commit
- `.humanlayer/workspace.local.json` — machine-specific overrides, gitignored

## steps to follow

<step index=0>

### Step 0: Check existing config and project context

Read any existing workspace config files:

```
Read(.humanlayer/workspace.json)
Read(.humanlayer/workspace.local.json)
```

Check if this is a git repository:

```
Bash(git rev-parse --show-toplevel)
Bash(git remote -v)
```

Check for coordination-repo signals (Claude config, additional sibling repos):

```
Read(.claude/settings.json)
Bash(ls -la ../)
```

If `.humanlayer/workspace.json` already exists, show the user the current config and ask if they want to update it or start fresh.

</step>

<step index=1>

### Step 1: Interview the user

Ask the user the following questions, adapting based on what you already found in Step 0. Do not ask questions whose answers are already obvious from the project context.

**Question A — Repo universe**

"Is this a single-repo project, or do you work on several related repositories at the same time for typical tasks?"

- If single repo: the config will have one entry `{ "localPath": ".", "primary": true }`
- If multi-repo: ask which sibling directories they typically work in (e.g. `../api`, `../web`). Check with `ls ../` to show them what's available.

**Question A.2 — Primary repo (multi-repo only)**

"Which repo should be the primary one — the default launch directory for sessions?"

Mark exactly one repo with `"primary": true`. Explain the implications when asking:
- Sessions in the workspace launch in the primary repo's worktree by default.
- Skills and instruction files (`CLAUDE.md`/`AGENTS.md`) are loaded from **all** repos in the workspace.
- Repo-local `.claude/settings*.json` / MCP-style configuration only governs sessions launched from a repo — so the repo holding the team's central Claude settings, MCP config, or agent policy should usually be primary.

Single-repo configs do not need an explicit `primary` (the one repo is always primary), but writing `"primary": true` is good practice.

**Question B — Worktree path layout (path template)**

"Where would you like worktrees to be created?"

Suggest two common options:
- `~/.humanlayer/workspaces/{{ TASKSLUG }}/{{ REPOBASENAME }}` — centralised, task-first layout (default)
- `~/wt/{{ REPOBASENAME }}/{{ TASKSLUG }}` — repo-first layout, similar to the old worktrees setup

If they have a `.humanlayer/worktrees.json` or `.humanlayer/worktrees.local.json`, show them the `basePath` from that file and suggest a compatible `pathTemplate`.

**Question C — Source ref**

"What git ref should worktrees be created from?"

Common answers:
- `HEAD` — current branch (default)
- `origin/main` — latest remote main (fetches before creation)
- `main` — local main branch

**Question D — Setup command**

"Is there a setup command to run after creating a worktree (e.g. `bun install`, `npm install`, `make setup`)?"

Check `package.json`, `Makefile`, and README for clues.

**Question E — Copy globs**

"Are there any local-only files that should be copied into each new worktree?"

The default list covers common cases:
```
.env
.env.local
.env.development.local
.claude/settings.local.json
.humanlayer/workspace.local.json
```

Ask if they have other local-only files (secrets, personal settings) that should be copied.

**Question F — Local overrides (for multi-machine users)**

"Do you need any machine-specific overrides, such as a different path template or a disabled repo?"

If yes, capture those as the `workspace.local.json` content.

</step>

<step index=2>

### Step 2: Generate and validate the config

Based on the interview answers, generate the workspace config.

**For single-repo projects, workspace.json looks like:**

```json
{
  "disabled": false,
  "pathTemplate": "~/.humanlayer/workspaces/{{ TASKSLUG }}/{{ REPOBASENAME }}",
  "branchTemplate": "{{ TASKSLUG }}",
  "sourceRef": "HEAD",
  "setupCommand": "",
  "copyGlobs": [
    ".env",
    ".env.local",
    ".env.development.local",
    ".claude/settings.local.json",
    ".humanlayer/workspace.local.json"
  ],
  "repos": [
    {
      "localPath": ".",
      "description": "Selected repository",
      "primary": true
    }
  ]
}
```

**For multi-repo projects (coordination repos), workspace.json looks like:**

```json
{
  "disabled": false,
  "pathTemplate": "~/.humanlayer/workspaces/{{ TASKSLUG }}/{{ REPOBASENAME }}",
  "branchTemplate": "{{ TASKSLUG }}",
  "sourceRef": "HEAD",
  "setupCommand": "bun install",
  "copyGlobs": [
    ".env",
    ".env.local",
    ".humanlayer/workspace.local.json"
  ],
  "repos": [
    {
      "localPath": ".",
      "description": "Coordination repo",
      "primary": true
    },
    {
      "localPath": "../api",
      "description": "API service",
      "setupCommand": "bun install"
    },
    {
      "localPath": "../web",
      "description": "Web frontend",
      "sourceRef": "origin/main"
    }
  ]
}
```

**Config rules to follow:**
- Multi-repo configs should mark exactly one repo with `"primary": true` — sessions launch in the primary repo's worktree by default, and its repo-local Claude/MCP configuration governs sessions. If no repo is marked, the task form asks the user to pick one.
- `localPath: "."` refers to the selected repository itself (the one containing this config); other entries are sibling paths relative to it
- Template variables are `{{ TASKSLUG }}` and `{{ REPOBASENAME }}` only
- `copyGlobs` is additive with de-duplication (defaults → workspace.json → workspace.local.json → per-repo), never replaced
- Repo entries may override `sourceRef`, `setupCommand`, `copyGlobs`, and `primary` — `branchTemplate` is always root-level
- `$patch: "delete"` is supported only in `workspace.local.json` repos entries, not in `workspace.json`
- `disabled: true` at root level disables all workspace setup options

**Validate the generated config:**

```
Bash(git remote -v)
```

For each repo `localPath`:
- Check the directory exists: `Bash(ls -la <localPath>)`
- Check it's a git repo: `Bash(git -C <localPath> rev-parse --git-dir)`
- If `sourceRef` has a remote prefix, verify the remote exists: `Bash(git -C <localPath> remote -v | grep <prefix>)`

If `setupCommand` is set, describe what it does (do not run it yet — setup commands run after worktree creation, not during config).

</step>

<step index=3>

### Step 3: Write the config files

Show the user the generated config and ask for confirmation before writing.

Write `workspace.json`:

```
Write(.humanlayer/workspace.json, <content>)
```

If there are local overrides, write `workspace.local.json` and ensure it is gitignored:

```
Write(.humanlayer/workspace.local.json, <content>)
```

Check `.gitignore` for the workspace.local.json entry:

```
Read(.gitignore)
```

If `.humanlayer/workspace.local.json` is not already ignored, add it:

```
Bash(echo '.humanlayer/workspace.local.json' >> .gitignore)
```

</step>

<step index=4>

### Step 4: Confirm and summarize

Show the user a summary of what was configured:

- Files written
- Number of repos configured
- Path template that will be used
- Setup command (if any)
- Copy globs summary

Explain the next steps:

```
The workspace configuration is now ready.

You can:
1. Return to the Riptide task creation UI and select "Now" for workspace setup
2. Or use the workspace config modal (Settings icon on the Workspace axis) to review/edit the config

When you create a task with "Workspace: Now", Riptide will:
- Create a git worktree for each configured repo at the rendered path
- Copy the configured files into each worktree
- Run the setup command in each worktree
- Start the task in the primary repo's worktree
```

If the user is on a team, remind them to commit `workspace.json` (but not `workspace.local.json`):

```
Bash(git add .humanlayer/workspace.json)
Bash(git status)
```

</step>

## Key concepts for this skill

### Template variables

Only two template variables are supported in v1:
- `{{ TASKSLUG }}` — the task slug (e.g. `eng-123-small-fix`)
- `{{ REPOBASENAME }}` — the basename of each repo's resolved `localPath` (e.g. `synclayer`, `api`, `web`)

### Repo precedence rules

Effective config = defaults → workspace.json → workspace.local.json

For `repos[]`:
- Local entry with matching `localPath` merges into that repo (local fields win)
- Local entry with new `localPath` adds a new repo
- Local entry with `$patch: "delete"` removes the repo from effective config

### copyGlobs semantics

`copyGlobs` at every level uses **additive merge with de-duplication**, never replacement. The effective list is built by concatenating defaults → `workspace.json` → `workspace.local.json` (and, per repo, the root list → the repo's own `copyGlobs`), dropping duplicates while preserving order. Setting `copyGlobs` in a local override or repo entry extends the inherited list — it cannot remove entries from it.

### Primary repo

In a multi-repo workspace, exactly one repo should carry `"primary": true`. The primary repo is the default launch directory for sessions in tasks created from this workspace: skills and instruction files load from all repos, but repo-local `.claude/settings*.json` / MCP configuration follows the launch directory, so the repo holding the team's central agent configuration should be primary. The task creation UI lets users override the primary per task, and prompts for a choice when a multi-repo config marks none. Single-repo configs are implicitly primary.

### Coordination repos

A coordination repo is a directory that doesn't contain the main project code but instead contains task management files (`.humanlayer/`, tickets, plans) and references sibling repos through `../api`, `../web`, etc. `localPath: "."` simply refers to the selected repository itself; mark whichever repo should be the default launch/config repo with `"primary": true`.

### disabled field

`disabled: true` at root level prevents workspace setup options that require worktree creation. The Riptide UI shows the source file that contributed `disabled: true` so users know which file to edit (or can re-enable in local overrides without touching shared config).
