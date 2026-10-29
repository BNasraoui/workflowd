/** No identity values are embedded in executable scripts or emitted in diagnostics. */
export const identityGuard = `#!/bin/sh
set -eu
blocked="$(dirname "$0")/blocked-emails"
[ -r "$blocked" ] || { echo 'workflowd: git identity policy unavailable' >&2; exit 1; }
check_emails() {
  while IFS= read -r email; do
    [ -n "$email" ] || continue
    normalized=$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')
    if grep -Fqx -- "$normalized" "$blocked"; then
      echo 'workflowd: blocked git identity; use the operator-configured agent identity' >&2
      exit 1
    fi
  done
}
case "$1" in
  commit)
    author=$(git var GIT_AUTHOR_IDENT) || exit 1
    committer=$(git var GIT_COMMITTER_IDENT) || exit 1
    printf '%s\\n' "$author" "$committer" | sed 's/.*<\\([^>]*\\)>.*/\\1/' | check_emails
    ;;
  push)
    export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
    while read -r local_ref local_oid remote_ref remote_oid; do
      case "$local_oid" in *[!0]*) ;; *) continue ;; esac
      case "$remote_oid" in
        *[!0]*) emails=$(git -c advice.graftFileDeprecated=false log --format='%ae%n%ce' "$local_oid" --not "$remote_oid" --remotes --) || exit 1 ;;
        *) emails=$(git -c advice.graftFileDeprecated=false log --format='%ae%n%ce' "$local_oid" --not --remotes --) || exit 1 ;;
      esac
      printf '%s\\n' "$emails" | check_emails || exit 1
    done
    ;;
esac
`

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const guardedHook = (guard: string, hook: string, previous: string) => {
  const original = `${quote(previous)}/${hook}`
  if (hook === "pre-push")
    return `#!/bin/sh
set -eu
input=$(mktemp)
trap 'rm -f "$input"' EXIT HUP INT TERM
cat > "$input"
${quote(guard)} push "$1" < "$input"
if [ -x ${original} ]; then ${original} "$@" < "$input"; fi
`
  const check = ["pre-commit", "prepare-commit-msg", "commit-msg"].includes(hook)
    ? `${quote(guard)} commit`
    : ""
  return `#!/bin/sh
set -eu
${check}
if [ -x ${original} ]; then ${original} "$@"; fi
`
}
