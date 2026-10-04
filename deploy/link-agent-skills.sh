#!/usr/bin/env bash
# link-agent-skills — expose a deploy checkout's RPI skills to local agents.
#
# Symlinks each skills/rpi-* directory of the checkout into ~/.agents/skills
# (Codex and OpenCode) and ~/.claude/skills (Claude Code). Safe to rerun.
# A path that exists and is not a symlink is never replaced: the script warns,
# links the remaining skills, and exits non-zero. Links into this checkout
# whose skill no longer exists are removed.
#
# Usage: link-agent-skills.sh <deploy-checkout>

set -euo pipefail

[ $# -eq 1 ] || {
	printf 'usage: link-agent-skills.sh <deploy-checkout>\n' >&2
	exit 2
}
DEPLOY=$(cd "$1" && pwd -P)
TARGETS="${SKILL_TARGETS:-$HOME/.agents/skills $HOME/.claude/skills}"

log() { printf '[link-agent-skills] %s\n' "$*"; }

conflicts=0
for target in $TARGETS; do
	mkdir -p "$target"

	for link in "$target"/rpi-*; do
		[ -L "$link" ] && [ ! -e "$link" ] || continue
		case "$(readlink "$link")" in
		"$DEPLOY"/skills/rpi-*)
			rm -f "$link"
			log "removed stale $link"
			;;
		esac
	done

	for skill in "$DEPLOY"/skills/rpi-*; do
		[ -f "$skill/SKILL.md" ] || continue
		link="$target/$(basename "$skill")"
		if [ -L "$link" ]; then
			[ "$(readlink "$link")" = "$skill" ] && continue
		elif [ -e "$link" ]; then
			log "WARN: $link exists and is not a symlink; leaving it"
			conflicts=1
			continue
		fi
		ln -sfn "$skill" "$link"
		log "linked $link"
	done
done

exit "$conflicts"
