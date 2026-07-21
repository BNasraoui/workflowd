#!/bin/sh

set -u

repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf '%s\n' "pre-push: cannot find the repository root" >&2
  exit 1
}

failed=0
bd_available=

while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$local_ref" ] || continue

  case "$local_ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac

  case "$local_sha" in
    *[!0]*) ;;
    *) continue ;;
  esac

  branch=${local_ref#refs/heads/}
  ticket_type=
  case "$branch" in
    feature/*) ticket_type=feature ;;
    bug/*) ticket_type=bug ;;
    task/*) ticket_type=task ;;
    chore/*) ticket_type=chore ;;
    epic/*) ticket_type=epic ;;
  esac

  branch_tail=${branch#*/}
  ticket_and_slug=${branch_tail#workflowd-}
  ticket_suffix=${ticket_and_slug%%-*}
  slug=${ticket_and_slug#*-}
  ticket_id=workflowd-$ticket_suffix

  if [ -z "$ticket_type" ] || [ "$branch_tail" = "$branch" ] ||
    [ "$ticket_and_slug" = "$branch_tail" ] || [ "$ticket_suffix" = "$ticket_and_slug" ] ||
    printf '%s\n' "$branch_tail" | grep -Eq '/' ||
    ! printf '%s\n' "$ticket_id" | grep -Eq '^workflowd-[a-z0-9]+(\.[a-z0-9]+)*$' ||
    ! printf '%s\n' "$slug" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'; then
    printf "pre-push: invalid local branch '%s'\n" "$branch" >&2
    printf '%s\n' "pre-push: expected <ticket-type>/<ticket-id>-<slug>" >&2
    printf '%s\n' "pre-push: example: feature/workflowd-feat-add-guard" >&2
    failed=1
    continue
  fi

  if [ -z "$bd_available" ]; then
    if command -v bd >/dev/null 2>&1; then
      bd_available=yes
    else
      bd_available=no
      printf '%s\n' "pre-push: bd is required to verify branch tickets" >&2
      printf '%s\n' "pre-push: install Beads, then retry the push" >&2
    fi
  fi

  if [ "$bd_available" = "no" ]; then
    failed=1
    continue
  fi

  if ! typed_count=$(bd --readonly -q -C "$repository_root" count --id "$ticket_id" --type "$ticket_type"); then
    printf "pre-push: could not verify ticket '%s' with bd\n" "$ticket_id" >&2
    failed=1
    continue
  fi

  if [ "$typed_count" = "1" ]; then
    continue
  fi

  if ! ticket_count=$(bd --readonly -q -C "$repository_root" count --id "$ticket_id"); then
    printf "pre-push: could not verify ticket '%s' with bd\n" "$ticket_id" >&2
    failed=1
    continue
  fi

  if [ "$ticket_count" = "0" ]; then
    printf "pre-push: ticket '%s' does not exist\n" "$ticket_id" >&2
  else
    printf "pre-push: ticket '%s' is not a '%s'\n" "$ticket_id" "$ticket_type" >&2
    printf "pre-push: inspect it with: bd show %s\n" "$ticket_id" >&2
  fi
  failed=1
done

if [ "$failed" -ne 0 ]; then
  printf '%s\n' "pre-push: rename the branch with: git branch -m <ticket-type>/<ticket-id>-<slug>" >&2
  printf '%s\n' "pre-push: bypass once with: git push --no-verify" >&2
  exit 1
fi
