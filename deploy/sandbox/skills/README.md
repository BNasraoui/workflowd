# Sandbox skills

`catalog.json` is the source of truth for skill names, descriptions, the container
root, upstream revisions, archive SHA-256 hashes, source folders and licenses.
`src/sandbox/config.ts` renders this catalog for all three harnesses;
`nix/agent-skills.nix` copies each complete folder into the image, alongside its
upstream license, and makes it read-only. The build checks the installed set and
frontmatter against the catalog. The image E2E also checks the exported image as
UID 1000, including readability and inability to write.

All included upstreams permit redistribution at the recorded revisions:

- obra/superpowers: MIT (`LICENSE`).
- mattpocock/skills: MIT (`LICENSE`).
- cursor/plugins: MIT (`cursor-team-kit/LICENSE`).
- kitlangton/skills: MIT (`LICENSE`).
- dmmulroy/skills: MIT (`LICENSE`).
- anthropics/skills frontend-design: Apache-2.0 (`skills/frontend-design/LICENSE.txt`).
- humanlayer/skills: MIT (`LICENSE`). The vendored visual-pr retains that notice
  and attribution. It uses the upstream description template and show-me
  reference, with publication replaced by `submit_result.body`. There is no
  network, GitHub CLI, push, saved-description, final-answer or session-footer step.

The catalog contains no rpi, find-skills or beads workflow. Included skills use
local task/spec context; instructions requiring unavailable tools do not confer
those capabilities.

## Discovery

Sandbox skills are read through container-use at `/opt/workflowd/skills`, not
through a host-native skill loader. Native discovery is disabled or denied:

- Codex 0.159.1: query `skills/list` on a short-lived app-server, then disable
  every discovered path with `skills.config` overrides. Plugins, apps and skill
  search are also disabled. The advertised `skip_host_skill_discovery` flag did
  not suppress discovery in the real CLI test, so it is not relied on.
- Claude: `--disable-slash-commands` disables all skills for this session
  ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- OpenCode v2: the reviewed sandbox agent's deny-all rule denies `skill`, hiding
  host skills from the model as well as rejecting loading
  ([skills permissions](https://dev.opencode.ai/v2/docs/skills/#permissions)).

The shared completion instructions supply the sole available catalog. Real CLI
and OpenCode tests use host-only skill canaries to catch discovery regressions.

## Rollout

Runner initialization selects `ghcr.io/bnasraoui/workflowd-agent-base:<tooling-sha>`
from the verified workflow identity before returning source readiness. This
local container-use setting is outside the exact source Git tree and is not
included in the result patch. Repository-selected base images are overridden.
The existing image publication workflow must publish that commit's image first.

This is a required result-schema change: old artifacts without `body` fail
closed. Drain old leases before deploying the controller and runner together.
Update the reviewed publisher action SHA in the lease caller and re-pin the
lease workflow to a matching branch tip after review; if a separate tooling pin
is configured, select the commit with the published image. This PR does not
change live pins, rulesets, environments, App settings or secrets.

## PR description validation

`body` is required, nonblank, well-formed Unicode, at most 32,768 UTF-8 bytes.
This also bounds Unicode character count below GitHub's 65,536-character limit,
leaving ample room for the publisher marker. Newlines are allowed; other Cc and
all Cf characters are rejected. The JSON transport/manifest envelope is bounded
at 256 KiB to allow JSON escaping of maximum-sized Unicode text.

Validation rejects every `<` and `@`, and every standalone case-insensitive
GitHub closing word (close/closes/closed, fix/fixes/fixed,
resolve/resolves/resolved), even inside code blocks. These conservative rules
also disallow harmless uses such as comparisons, email addresses and prose
containing a closing word. They avoid relying on context-sensitive Markdown
parsing or GitHub's notification/linkification behavior. Agents receive a tool
error before anything is sealed and can rephrase and resubmit. No approved
text is silently neutralized or rewritten.

The exact accepted body is part of the sealed manifest and its approval-bound
SHA-256 digest. The publisher renders `marker + "\n\n" + body`; the controller and
publisher both require that exact deterministic body during recovery. The
squashed commit continues to use `commitMessage` with the existing configured
co-author handling.
