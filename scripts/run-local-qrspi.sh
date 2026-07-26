#!/usr/bin/env bash
set -euo pipefail

readonly PROGRAM_NAME=${0##*/}
readonly -a STAGES=(questions research design structure plan implementation)
readonly MAX_DESIGN_REVISIONS=5
readonly MAX_STRUCTURE_REVISIONS=5

repo=""
skills_root=${QRISPI_SKILLS_ROOT:-}
from_stage=questions
to_stage=implementation
agent=${QRISPI_AGENT:-build}
model=${QRISPI_MODEL:-}
dry_run=false
prepare_only=false
refresh_ticket=false
claim=true
recursive=true
auto_approve=false
use_worktree=false
worktree_root=""
worktree_prepared=false
worktree_bead_id=""
delivery_root_id=""
current_package_sha=""
current_binding_sha=""
current_gate_sha=""
declare -a bead_ids=()

BD_BIN=${QRISPI_BD_BIN:-bd}
OPENCODE_BIN=${QRISPI_OPENCODE_BIN:-opencode}
PROMOTION_COMMAND=${QRISPI_PROMOTION_COMMAND:-}

usage() {
  printf '%s\n' "Usage: $PROGRAM_NAME [options] <bead-id> [<bead-id> ...]"
  printf '%s\n' ""
  printf '%s\n' "Run local, human-gated QRISPI stages for one or more Beads."
  printf '%s\n' ""
  printf '%s\n' "Options:"
  printf '%s\n' "  --repo <path>          Repository to work in (default: current Git root)"
  printf '%s\n' "  --skills-root <path>   Riptide skills directory"
  printf '%s\n' "  --from <stage>         First stage to run (default: questions)"
  printf '%s\n' "  --to <stage>           Last stage to run (default: implementation)"
  printf '%s\n' "  --stage <stage>        Run one stage"
  printf '%s\n' "  --agent <name>         OpenCode primary agent (default: build)"
  printf '%s\n' "  --model <id>           Optional OpenCode model override"
  printf '%s\n' "  --prepare-only         Write ticket snapshots, then stop"
  printf '%s\n' "  --refresh-ticket       Replace an existing ticket snapshot"
  printf '%s\n' "  --dry-run              Show stages without writing or launching agents"
  printf '%s\n' "  --auto-approve         Run stages non-interactively and accept successful outputs"
  printf '%s\n' "  --worktree             Create/adopt one worktree for the delivery run"
  printf '%s\n' "  --worktree-root <path> Parent directory for the generated worktree"
  printf '%s\n' "  --no-claim             Do not claim open Beads before running"
  printf '%s\n' "  --no-recursive         Do not descend into child Beads after Structure"
  printf '%s\n' "  -h, --help             Show this help"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local option=$1
  local value=${2:-}
  [[ -n "$value" ]] || fail "$option requires a value"
}

while (($# > 0)); do
  case "$1" in
    --repo)
      require_value "$1" "${2:-}"
      repo=$2
      shift 2
      ;;
    --skills-root)
      require_value "$1" "${2:-}"
      skills_root=$2
      shift 2
      ;;
    --from)
      require_value "$1" "${2:-}"
      from_stage=$2
      shift 2
      ;;
    --to)
      require_value "$1" "${2:-}"
      to_stage=$2
      shift 2
      ;;
    --stage)
      require_value "$1" "${2:-}"
      from_stage=$2
      to_stage=$2
      shift 2
      ;;
    --agent)
      require_value "$1" "${2:-}"
      agent=$2
      shift 2
      ;;
    --model)
      require_value "$1" "${2:-}"
      model=$2
      shift 2
      ;;
    --prepare-only)
      prepare_only=true
      shift
      ;;
    --refresh-ticket)
      refresh_ticket=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --auto-approve)
      auto_approve=true
      shift
      ;;
    --worktree)
      use_worktree=true
      shift
      ;;
    --worktree-root)
      require_value "$1" "${2:-}"
      worktree_root=$2
      shift 2
      ;;
    --no-claim)
      claim=false
      shift
      ;;
    --no-recursive)
      recursive=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      bead_ids+=("$@")
      break
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      bead_ids+=("$1")
      shift
      ;;
  esac
done

((${#bead_ids[@]} > 0)) || {
  usage >&2
  exit 1
}

command -v "$BD_BIN" >/dev/null 2>&1 || fail "bd executable not found: $BD_BIN"
command -v jq >/dev/null 2>&1 || fail "jq is required"

if [[ -z "$repo" ]]; then
  repo=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git repository; pass --repo"
fi
repo=$(realpath "$repo")
[[ -d "$repo" ]] || fail "repository does not exist: $repo"
readonly source_repo=$repo
active_repo=$repo
if [[ -z "$worktree_root" ]]; then
  worktree_root=$(dirname "$source_repo")
fi

discover_skills_root() {
  local candidate
  local latest=""

  if [[ -d "$source_repo/.humanlayer/skills" ]]; then
    printf '%s\n' "$source_repo/.humanlayer/skills"
    return 0
  fi

  for candidate in "$HOME"/.humanlayer/riptide/plugins/riptide-rpi/*/skills; do
    [[ -d "$candidate" ]] || continue
    if [[ -z "$latest" ]] || [[ "${candidate%/skills}" > "${latest%/skills}" ]]; then
      latest=$candidate
    fi
  done

  [[ -n "$latest" ]] || fail "Riptide skills not found; pass --skills-root"
  printf '%s\n' "$latest"
}

if [[ -z "$skills_root" ]]; then
  skills_root=$(discover_skills_root)
fi
skills_root=$(realpath "$skills_root")
[[ -d "$skills_root" ]] || fail "skills root does not exist: $skills_root"

if [[ "$dry_run" == false && "$prepare_only" == false ]]; then
  command -v "$OPENCODE_BIN" >/dev/null 2>&1 || fail "opencode executable not found: $OPENCODE_BIN"
fi

stage_index() {
  local wanted=$1
  local index
  for index in "${!STAGES[@]}"; do
    if [[ "${STAGES[$index]}" == "$wanted" ]]; then
      printf '%s\n' "$index"
      return 0
    fi
  done
  return 1
}

from_index=$(stage_index "$from_stage") || fail "unknown stage: $from_stage"
to_index=$(stage_index "$to_stage") || fail "unknown stage: $to_stage"
((from_index <= to_index)) || fail "--from stage must not come after --to stage"

slugify() {
  local value=$1
  value=${value,,}
  value=$(printf '%s' "$value" | tr -cs 'a-z0-9' '-')
  value=${value#-}
  value=${value%-}
  value=${value:0:64}
  value=${value%-}
  [[ -n "$value" ]] || value=task
  printf '%s\n' "$value"
}

normalize_ticket() {
  jq -ce '
    if type == "array" then
      if length == 1 then .[0] else error("bd show returned an unexpected issue count") end
    elif type == "object" then .
    else error("bd show returned an unexpected JSON value")
    end
  '
}

render_ticket_markdown() {
  jq -r '
    def section($heading; $value):
      if ($value // "") == "" then "" else "\n## " + $heading + "\n\n" + $value + "\n" end;
    def labels:
      if ((.labels // []) | length) == 0 then "" else
        "\n**Labels:** " + ((.labels // []) | map("`" + . + "`") | join(", ")) + "\n"
      end;
    def dependencies:
      (.dependencies // []) |
      if length == 0 then "" else
        map(
          "- `" + (.id // .depends_on_id // .issue_id // "unknown") + "`" +
          (if (.title // "") == "" then "" else ": " + .title end) +
          (if (.dependency_type // .type // "") == "" then "" else " (" + (.dependency_type // .type) + ")" end)
        ) | join("\n")
      end;
    "# " + .title + "\n\n" +
    "**Bead:** `" + .id + "`  \n" +
    "**Type:** " + (.issue_type // "unknown") + "  \n" +
    "**Priority:** P" + ((.priority // "unknown") | tostring) + "  \n" +
    "**Status at snapshot:** " + (.status // "unknown") + "\n" +
    labels +
    section("Description"; .description) +
    section("Design"; .design) +
    section("Acceptance Criteria"; .acceptance_criteria) +
    section("Notes"; .notes) +
    section("Dependencies"; dependencies)
  '
}

semantic_ticket() {
  jq -cS '{
    id,
    title,
    description,
    design,
    acceptance_criteria,
    notes,
    issue_type,
    priority,
    labels,
    dependencies,
    parent
  }'
}

task_directory_for() {
  local bead_id=$1
  local title=$2
  local tasks_root="$active_repo/.humanlayer/tasks"
  local -a matches=()
  local match

  if [[ -d "$tasks_root" ]]; then
    shopt -s nullglob
    for match in "$tasks_root/$bead_id"-*; do
      [[ -d "$match" ]] && matches+=("$match")
    done
    shopt -u nullglob
  fi

  if ((${#matches[@]} > 1)); then
    fail "multiple task directories exist for $bead_id; remove the ambiguity before resuming"
  elif ((${#matches[@]} == 1)); then
    printf '%s\n' "${matches[0]}"
  else
    printf '%s/%s-%s\n' "$tasks_root" "$bead_id" "$(slugify "$title")"
  fi
}

write_ticket_snapshot() {
  local task_directory=$1
  local ticket_json=$2
  local json_path="$task_directory/ticket.json"
  local markdown_path="$task_directory/ticket.md"
  local temporary

  if [[ -f "$json_path" && "$refresh_ticket" == false ]]; then
    if [[ "$(semantic_ticket < "$json_path")" != "$(printf '%s\n' "$ticket_json" | semantic_ticket)" ]]; then
      fail "Bead meaning changed since $json_path was written; review it and rerun with --refresh-ticket"
    fi
    return 0
  fi

  mkdir -p "$task_directory"
  temporary=$(mktemp "$task_directory/.ticket.json.XXXXXX")
  printf '%s\n' "$ticket_json" | jq '.' > "$temporary"
  mv -f "$temporary" "$json_path"

  temporary=$(mktemp "$task_directory/.ticket.md.XXXXXX")
  printf '%s\n' "$ticket_json" | render_ticket_markdown > "$temporary"
  mv -f "$temporary" "$markdown_path"
}

is_ready() {
  local bead_id=$1
  "$BD_BIN" ready --json | jq -e --arg id "$bead_id" 'any(.[]; .id == $id)' >/dev/null
}

stage_accepted() {
  local task_directory=$1
  local stage=$2
  local state_path="$task_directory/.qrispi-state"
  local recorded_stage
  local recorded_status
  local remainder

  [[ -f "$state_path" ]] || return 1
  while IFS='|' read -r recorded_stage recorded_status remainder; do
    if [[ "$recorded_stage" == "$stage" && "$recorded_status" == accepted ]]; then
      case "$stage:$remainder" in
        design:03-provenance-promotion-result-r*.json\|*) return 0 ;;
        design:*) continue ;;
        structure:04-structure-outline-*.md\|*|structure:04-structure-canonical-r*.md\|*) return 0 ;;
        structure:*) continue ;;
        *) return 0 ;;
      esac
    fi
  done < "$state_path"
  return 1
}

inherited_design_directory_for() {
  local bead_id=$1
  local current_id=$bead_id
  local depth=0
  local parent_id
  local parent_json
  local parent_title
  local parent_directory

  while ((depth < 32)); do
    depth=$((depth + 1))
    parent_id=$("$BD_BIN" show "$current_id" --json | normalize_ticket | jq -r \
      'if .parent == null then "" elif (.parent | type) == "object" then .parent.id // "" else .parent end') || return 1
    [[ -n "$parent_id" ]] || return 1
    parent_json=$("$BD_BIN" show "$parent_id" --json | normalize_ticket) || return 1
    parent_title=$(printf '%s\n' "$parent_json" | jq -r '.title')
    parent_directory=$(task_directory_for "$parent_id" "$parent_title") || return 1
    if stage_accepted "$parent_directory" design; then
      printf '%s\n' "$parent_directory"
      return 0
    fi
    current_id=$parent_id
  done
  return 1
}

artifact_for_stage() {
  local task_directory=$1
  local stage=$2
  local candidate
  local -a matches=()

  shopt -s nullglob
  case "$stage" in
    questions)
      matches=("$task_directory"/*-research-questions-*.md)
      ;;
    research)
      for candidate in "$task_directory"/*-research-*.md; do
        [[ "$candidate" == *-research-questions-* ]] || matches+=("$candidate")
      done
      ;;
    design)
      matches=("$task_directory"/*-design-discussion-*.md)
      ;;
    structure)
      matches=("$task_directory"/*-structure-outline-*.md)
      ;;
    plan)
      matches=("$task_directory"/*-plan-*.md)
      ;;
    implementation)
      ;;
  esac
  shopt -u nullglob

  if ((${#matches[@]} > 0)); then
    printf '%s\n' "${matches[${#matches[@]} - 1]}"
  fi
}

create_skill_for_stage() {
  case "$1" in
    questions) printf '%s\n' create-research-questions ;;
    research) printf '%s\n' create-research ;;
    design) printf '%s\n' create-design-discussion ;;
    structure) printf '%s\n' create-structure-outline ;;
    plan) printf '%s\n' create-plan ;;
    implementation) printf '%s\n' implement-plan ;;
  esac
}

iterate_skill_for_stage() {
  case "$1" in
    questions) printf '%s\n' iterate-research-questions ;;
    research) printf '%s\n' iterate-research ;;
    design) printf '%s\n' iterate-design-discussion ;;
    structure) printf '%s\n' iterate-structure-outline ;;
    plan) printf '%s\n' iterate-plan ;;
    implementation) printf '%s\n' implement-plan ;;
  esac
}

record_acceptance() {
  local task_directory=$1
  local stage=$2
  local artifact=${3:-}
  local state_path="$task_directory/.qrispi-state"
  local temporary
  local digest="-"
  local recorded_stage
  local recorded_status
  local recorded_artifact
  local recorded_digest

  if [[ -n "$artifact" && -f "$artifact" ]]; then
    digest=$(sha256sum "$artifact" | cut -d ' ' -f 1)
    artifact=${artifact#"$task_directory/"}
  else
    artifact="-"
  fi

  temporary=$(mktemp "$task_directory/.qrispi-state.XXXXXX")
  if [[ -f "$state_path" ]]; then
    while IFS='|' read -r recorded_stage recorded_status recorded_artifact recorded_digest; do
      [[ "$recorded_stage" == "$stage" ]] || printf '%s|%s|%s|%s\n' \
        "$recorded_stage" "$recorded_status" "$recorded_artifact" "$recorded_digest" >> "$temporary"
    done < "$state_path"
  fi
  printf '%s|accepted|%s|%s\n' "$stage" "$artifact" "$digest" >> "$temporary"
  mv -f "$temporary" "$state_path"
}

invalidate_stage_acceptance() {
  local task_directory=$1
  shift
  local state_path="$task_directory/.qrispi-state"
  local temporary
  local recorded_stage
  local recorded_status
  local recorded_artifact
  local recorded_digest
  local invalidated

  [[ -f "$state_path" ]] || return 0
  temporary=$(mktemp "$task_directory/.qrispi-state.XXXXXX")
  while IFS='|' read -r recorded_stage recorded_status recorded_artifact recorded_digest; do
    invalidated=false
    for stage in "$@"; do
      if [[ "$recorded_stage" == "$stage" ]]; then
        invalidated=true
        break
      fi
    done
    [[ "$invalidated" == true ]] || printf '%s|%s|%s|%s\n' \
      "$recorded_stage" "$recorded_status" "$recorded_artifact" "$recorded_digest" >> "$temporary"
  done < "$state_path"
  mv -f "$temporary" "$state_path"
}

loop_checkpoint_accepted() {
  local task_directory=$1
  local key=$2
  local state_path="$task_directory/.qrispi-loop-state"
  local recorded_key
  local recorded_status
  local recorded_artifact
  local recorded_digest
  local artifact

  [[ -f "$state_path" ]] || return 1
  while IFS='|' read -r recorded_key recorded_status recorded_artifact recorded_digest; do
    [[ "$recorded_key" == "$key" && "$recorded_status" == accepted ]] || continue
    artifact="$task_directory/$recorded_artifact"
    [[ -f "$artifact" && "$(sha256sum "$artifact" | cut -d ' ' -f 1)" == "$recorded_digest" ]]
    return
  done < "$state_path"
  return 1
}

record_loop_checkpoint() {
  local task_directory=$1
  local key=$2
  local artifact=$3
  local state_path="$task_directory/.qrispi-loop-state"
  local temporary
  local digest
  local recorded_key
  local recorded_status
  local recorded_artifact
  local recorded_digest

  [[ -f "$artifact" ]] || fail "$key did not create $artifact"
  digest=$(sha256sum "$artifact" | cut -d ' ' -f 1)
  artifact=${artifact#"$task_directory/"}
  temporary=$(mktemp "$task_directory/.qrispi-loop-state.XXXXXX")
  if [[ -f "$state_path" ]]; then
    while IFS='|' read -r recorded_key recorded_status recorded_artifact recorded_digest; do
      [[ "$recorded_key" == "$key" ]] || printf '%s|%s|%s|%s\n' \
        "$recorded_key" "$recorded_status" "$recorded_artifact" "$recorded_digest" >> "$temporary"
    done < "$state_path"
  fi
  printf '%s|accepted|%s|%s\n' "$key" "$artifact" "$digest" >> "$temporary"
  mv -f "$temporary" "$state_path"
}

revision_for() {
  local task_directory=$1
  local stage=$2
  local revision_path="$task_directory/.qrispi-$stage-revision"
  local revision

  if [[ -f "$revision_path" ]]; then
    IFS= read -r revision < "$revision_path"
    printf '%s\n' "$revision"
  else
    printf '%s\n' 1
  fi
}

advance_revision() {
  local task_directory=$1
  local stage=$2
  local artifact=$3
  local revision
  local history="$task_directory/.qrispi-history"

  revision=$(revision_for "$task_directory" "$stage")
  mkdir -p "$history"
  [[ ! -f "$artifact" ]] || cp -f "$artifact" "$history/${artifact##*/}-r$revision"
  revision=$((revision + 1))
  printf '%s\n' "$revision" > "$task_directory/.qrispi-$stage-revision"
}

stage_prompt() {
  local bead_id=$1
  local task_directory=$2
  local stage=$3
  local skill_name=$4
  local skill_directory="$skills_root/$skill_name"

  printf '%s\n' "Run the attached Riptide $skill_name skill for Bead $bead_id."
  printf '%s\n' "The task directory is $task_directory. Treat $skill_directory as {SKILLBASE}."
  printf '%s\n' "Use the repository's AGENTS.md rules and Beads for durable tracking."
  printf '%s\n' "Map Riptide agent names as follows: codebase-locator to locator, codebase-analyzer to analyzer, codebase-pattern-finder to pattern-finder, web-search-researcher to web-researcher, and implementer-agent or rpi:outline-implementer-agent to general."
  if [[ "$auto_approve" == true ]]; then
    printf '%s\n' "The human explicitly auto-approves your recommended answer at every QRISPI decision and review gate. Complete this stage autonomously in this invocation and choose your recommended option whenever the skill would ask a question."
    printf '%s\n' "You may create local implementation commits when the implementation skill requires them. Never push, create or update a pull request, close the Bead, or run Dolt remote sync."
  else
    printf '%s\n' "Do not commit, push, create or update a pull request, close the Bead, or run Dolt remote sync. The local runner and human own those effects."
    printf '%s\n' "Keep every human review gate in the skill. Do not infer approval from this launch prompt."
  fi
  if [[ "$stage" == structure || "$stage" == plan || "$stage" == implementation ]]; then
    local inherited_design=""
    if ! stage_accepted "$task_directory" design; then
      inherited_design=$(inherited_design_directory_for "$bead_id" || true)
    fi
    if [[ -n "$inherited_design" && "$inherited_design" != "$task_directory" ]]; then
      printf '%s\n' "This split child inherits its accepted promoted Design authority from ancestor task directory $inherited_design. Read the accepted 03-design-discussion and 03-design-acceptance artifacts there and treat them as this Bead's Design authority; do not expect a Design artifact inside $task_directory."
    fi
  fi
  if [[ "$stage" == structure ]]; then
    printf '%s\n' "Produce only the Structure outline. Do not estimate its size, compare it with another Structure, create child Beads, Plan, or implement. The runner launches the independent post-Structure scope review separately."
    printf '%s\n' "In local-qrispi compatibility mode, a confirmed content-addressed local graph export is the explicitly authorized snapshot substitute. Disclose that limitation and do not claim production Provenance publication or authority."
  fi
  if [[ "$stage" == implementation ]]; then
    printf '%s\n' "Follow test-driven development and implement only accepted Plan work. In auto-approve mode, run all automated checks and continue through phase gates without waiting for human verification."
    printf '%s\n' "Treat the auto-approved gate response as permission to run the implementation autonomously in this invocation. Do not launch another QRSPI runner or dispatch separate mint jobs. Commit production changes only when the implementation skill requires them; the runner owns final validation, Bead closure, and delivery."
  fi
}

run_stage() {
  local bead_id=$1
  local task_directory=$2
  local stage=$3
  local accept_stage=${4:-true}
  local artifact
  local skill_name
  local skill_file
  local response
  local -a command

  if [[ "$accept_stage" == true ]] && stage_accepted "$task_directory" "$stage"; then
    printf 'skip %s (accepted)\n' "$stage"
    return 0
  fi

  artifact=$(artifact_for_stage "$task_directory" "$stage")
  if [[ -n "$artifact" ]]; then
    skill_name=$(iterate_skill_for_stage "$stage")
  else
    skill_name=$(create_skill_for_stage "$stage")
  fi
  skill_file="$skills_root/$skill_name/SKILL.md"
  [[ -f "$skill_file" ]] || fail "missing Riptide skill: $skill_file"

  if [[ "$dry_run" == true ]]; then
    if [[ "$auto_approve" == true ]]; then
      printf 'stage %s: opencode run --auto --file %s\n' "$stage" "$skill_file"
    else
      printf 'stage %s: opencode run -i --file %s\n' "$stage" "$skill_file"
    fi
    return 0
  fi

  if [[ "$auto_approve" == true ]]; then
    command=("$OPENCODE_BIN" run --auto --dir "$active_repo" --agent "$agent" --title "QRISPI $stage: $bead_id" --file "$skill_file")
  else
    [[ -t 0 && -t 1 ]] || fail "stage execution requires an interactive terminal"
    command=("$OPENCODE_BIN" run -i --dir "$active_repo" --agent "$agent" --title "QRISPI $stage: $bead_id" --file "$skill_file")
  fi
  if [[ -n "$model" ]]; then
    command+=(--model "$model")
  fi

  while true; do
    "${command[@]:0:2}" "$(stage_prompt "$bead_id" "$task_directory" "$stage" "$skill_name")" "${command[@]:2}"
    artifact=$(artifact_for_stage "$task_directory" "$stage")
    if [[ "$stage" != implementation && -z "$artifact" ]]; then
      fail "$stage session exited without creating its artifact in $task_directory"
    fi
    if [[ "$accept_stage" == false ]]; then
      invalidate_stage_acceptance "$task_directory" "$stage"
    fi

    if [[ "$auto_approve" == true ]]; then
      [[ "$accept_stage" == true ]] && record_acceptance "$task_directory" "$stage" "$artifact"
      if [[ "$stage" == plan ]]; then
        commit_delivery_changes "$bead_id" "Plan $bead_id"
      fi
      return 0
    fi

    [[ "$accept_stage" == true ]] || return 0

    printf '\nMark %s accepted and continue? [y]es, [r]evise, [s]top: ' "$stage"
    IFS= read -r response
    case "$response" in
      y|Y|yes|YES)
        record_acceptance "$task_directory" "$stage" "$artifact"
        return 0
        ;;
      r|R|revise|REVISE)
        skill_name=$(iterate_skill_for_stage "$stage")
        skill_file="$skills_root/$skill_name/SKILL.md"
        [[ -f "$skill_file" ]] || fail "missing Riptide iteration skill: $skill_file"
        command=("$OPENCODE_BIN" run -i --dir "$active_repo" --agent "$agent" --title "QRISPI $stage revision: $bead_id" --file "$skill_file")
        [[ -z "$model" ]] || command+=(--model "$model")
        ;;
      s|S|stop|STOP|"")
        printf 'stopped after %s; rerun the command to resume\n' "$stage"
        return 2
        ;;
      *)
        printf 'unknown response: %s\n' "$response" >&2
        ;;
    esac
  done
}

markdown_verdict() {
  local artifact=$1
  awk '
    /^## Verdict[[:space:]]*$/ { in_verdict = 1; next }
    in_verdict && NF {
      gsub(/[`[:space:]]/, "", $0)
      print
      exit
    }
  ' "$artifact"
}

loop_prompt() {
  local bead_id=$1
  local task_directory=$2
  local step=$3
  local output=$4
  local instructions=$5

  printf '%s\n' "Run the attached repository skill for local QRISPI step $step on Bead $bead_id."
  printf '%s\n' "The task directory is $task_directory. Write the sole step artifact to $output."
  printf '%s\n' "This invocation is an independent session. Do not edit the producer artifact, product code, Beads, Git history, remotes, or pull requests."
  printf '%s\n' "$instructions"
  if [[ "$auto_approve" == true ]]; then
    printf '%s\n' "The human authorizes the recommended answer at decision gates, but you must not fabricate missing evidence, authority, authentication, or a Provenance graph snapshot."
  fi
}

run_repo_skill_step() {
  local bead_id=$1
  local task_directory=$2
  local step=$3
  local skill_name=$4
  local output=$5
  local instructions=$6
  local record=${7:-true}
  local skill_file="$active_repo/skills/$skill_name/SKILL.md"
  local -a command

  if loop_checkpoint_accepted "$task_directory" "$step"; then
    printf 'skip %s (accepted)\n' "$step"
    return 0
  fi
  if [[ "$dry_run" == true ]]; then
    printf 'loop %s: opencode run --file %s\n' "$step" "$skill_file"
    return 0
  fi
  [[ -f "$skill_file" ]] || fail "missing repository skill: $skill_file"

  if [[ "$auto_approve" == true ]]; then
    command=("$OPENCODE_BIN" run --auto --dir "$active_repo" --agent "$agent" --title "QRISPI $step: $bead_id" --file "$skill_file")
  else
    [[ -t 0 && -t 1 ]] || fail "loop execution requires an interactive terminal"
    command=("$OPENCODE_BIN" run -i --dir "$active_repo" --agent "$agent" --title "QRISPI $step: $bead_id" --file "$skill_file")
  fi
  [[ -z "$model" ]] || command+=(--model "$model")

  QRISPI_OUTPUT_PATH="$output" \
  QRISPI_STEP="$step" \
  QRISPI_PACKAGE_SHA256="$current_package_sha" \
  QRISPI_BINDING_SHA256="$current_binding_sha" \
  QRISPI_GATE_SHA256="$current_gate_sha" \
    "${command[@]:0:2}" \
    "$(loop_prompt "$bead_id" "$task_directory" "$step" "$output" "$instructions")" \
    "${command[@]:2}"
  [[ -f "$output" ]] || fail "$step session exited without creating $output"
  [[ "$record" == false ]] || record_loop_checkpoint "$task_directory" "$step" "$output"
}

create_scope_children() {
  local bead_id=$1
  local task_directory=$2
  local structure=$3
  local review=$4
  local step=$5
  local output=$6
  local skill_file="$active_repo/skills/ticket-writing/SKILL.md"
  local -a command

  [[ -f "$skill_file" ]] || fail "missing repository skill: $skill_file"

  if [[ "$auto_approve" == true ]]; then
    command=("$OPENCODE_BIN" run --auto --dir "$active_repo" --agent "$agent" --title "QRSPI $step: $bead_id" --file "$skill_file")
  else
    [[ -t 0 && -t 1 ]] || fail "scope child creation requires an interactive terminal"
    command=("$OPENCODE_BIN" run -i --dir "$active_repo" --agent "$agent" --title "QRSPI $step: $bead_id" --file "$skill_file")
  fi
  [[ -z "$model" ]] || command+=(--model "$model")

  "${command[@]:0:2}" \
    "$(printf '%s\n' \
      "Use the attached ticket-writing skill to materialize the recursive scope decomposition for Bead $bead_id." \
      "Read the current ticket at $task_directory/ticket.json, the accepted Structure at $structure, and the scope review at $review." \
      "Create one Beads task under parent $bead_id for every proposed child outcome in the review. Preserve each outcome, dependencies, primary files, provisional estimate, and exact acceptance/control/risk coverage in ticket-template fields. Do not treat proposed children as implementation-ready leaves; every child requires its own Structure scope review before Plan." \
      "Use the bd CLI to create children and add dependencies. Follow the existing ticket style, labels, and ticket-template format. Do not implement, Plan, modify Git, close Beads, run Dolt remote sync, or create pull requests." \
      "Write a brief creation manifest to $output listing each created child ID, title, and dependencies. The human authorized this automated recursive QRSPI gate decision.")" \
    "${command[@]:2}"
  [[ -f "$output" ]] || fail "scope child creation did not create $output"
  record_loop_checkpoint "$task_directory" "$step" "$output"
}

commit_delivery_changes() {
  local bead_id=$1
  local message=$2

  [[ "$dry_run" == false ]] || return 0
  [[ -n "$(git -C "$active_repo" status --porcelain --untracked-files=all)" ]] || return 0
  git -C "$active_repo" add -- .humanlayer/tasks
  git -C "$active_repo" commit -m "$message"
}

push_delivery_branch() {
  local current_branch

  [[ "$auto_approve" == true && "$dry_run" == false ]] || return 0
  current_branch=$(git -C "$active_repo" branch --show-current)
  [[ "$current_branch" == opencode/* ]] || return 0
  git -C "$active_repo" push --set-upstream origin "$current_branch"
}

close_split_parent() {
  local bead_id=$1
  local children_json
  local total
  local closed_count

  [[ "$auto_approve" == true && "$dry_run" == false ]] || return 0
  children_json=$("$BD_BIN" list --parent "$bead_id" --all --json)
  total=$(printf '%s\n' "$children_json" | jq 'length')
  closed_count=$(printf '%s\n' "$children_json" | jq '[.[] | select(.status == "closed")] | length')
  if ((total > 0 && total == closed_count)); then
    "$BD_BIN" update "$bead_id" --notes "All split children completed through recursive local QRSPI delivery." >/dev/null
    "$BD_BIN" close "$bead_id" --reason "All split children completed through recursive local QRSPI delivery." >/dev/null
    printf 'closed split parent %s\n' "$bead_id"
    push_delivery_branch
  fi
}

write_design_binding() {
  local bead_id=$1
  local task_directory=$2
  local revision=$3
  local design=$4
  local ownership=$5
  local output=$6
  local questions
  local research
  local repository_base
  local design_sha
  local ownership_sha
  local questions_sha
  local research_sha
  local source_set_sha
  local design_policy_sha
  local impact_policy_sha
  local structure_policy_sha
  local design_acceptance_policy_sha
  local promotion_policy_sha
  local workflow_definition_sha
  local temporary

  questions=$(artifact_for_stage "$task_directory" questions)
  research=$(artifact_for_stage "$task_directory" research)
  [[ -f "$questions" ]] || fail "Design acceptance requires accepted Questions"
  [[ -f "$research" ]] || fail "Design acceptance requires accepted Research"
  repository_base=$(git -C "$active_repo" rev-parse HEAD 2>/dev/null || printf '%s' local-uncommitted)
  design_sha=$(sha256sum "$design" | cut -d ' ' -f 1)
  ownership_sha=$(sha256sum "$ownership" | cut -d ' ' -f 1)
  questions_sha=$(sha256sum "$questions" | cut -d ' ' -f 1)
  research_sha=$(sha256sum "$research" | cut -d ' ' -f 1)
  source_set_sha=$(printf '%s\n%s\n' "$questions_sha" "$research_sha" | sha256sum | cut -d ' ' -f 1)
  design_policy_sha=$(sha256sum "$active_repo/skills/design-boundary-reviewer/SKILL.md" | cut -d ' ' -f 1)
  impact_policy_sha=$(sha256sum "$active_repo/skills/impact-risk-reviewer/SKILL.md" | cut -d ' ' -f 1)
  structure_policy_sha=$(sha256sum "$active_repo/skills/qrspi-design-structure/SKILL.md" | cut -d ' ' -f 1)
  design_acceptance_policy_sha=$(printf '%s\n%s\n%s\n' \
    "$design_policy_sha" "$impact_policy_sha" "$structure_policy_sha" | sha256sum | cut -d ' ' -f 1)
  if [[ -n "$PROMOTION_COMMAND" && -f "$PROMOTION_COMMAND" ]]; then
    promotion_policy_sha=$(sha256sum "$PROMOTION_COMMAND" | cut -d ' ' -f 1)
  else
    promotion_policy_sha=$(printf '%s\n' local-provenance-promotion-unavailable | sha256sum | cut -d ' ' -f 1)
  fi
  workflow_definition_sha=$(printf '%s\n%s\n%s\n' "$design_policy_sha" "$impact_policy_sha" "$structure_policy_sha" | sha256sum | cut -d ' ' -f 1)
  temporary=$(mktemp "$task_directory/.design-binding.XXXXXX")
  jq -n \
    --arg workflowId "$(basename "$active_repo"):$bead_id" \
    --argjson generation 1 \
    --argjson revision "$revision" \
    --arg repositoryBase "$repository_base" \
    --arg workflowDefinitionSha256 "$workflow_definition_sha" \
    --arg designPath "$design" --arg designSha256 "$design_sha" \
    --arg ownershipPath "$ownership" --arg ownershipSha256 "$ownership_sha" \
    --arg questionsPath "$questions" --arg questionsSha256 "$questions_sha" \
    --arg researchPath "$research" --arg researchSha256 "$research_sha" \
    --arg sourceSetSha256 "$source_set_sha" \
    --arg designPolicySha256 "$design_policy_sha" \
    --arg impactPolicySha256 "$impact_policy_sha" \
    --arg structurePolicySha256 "$structure_policy_sha" \
    --arg designAcceptancePolicySha256 "$design_acceptance_policy_sha" \
    --arg promotionPolicySha256 "$promotion_policy_sha" \
    '{
      contractVersion: 1,
      mode: "local-qrispi",
      workflowId: $workflowId,
      generation: $generation,
      designRevision: $revision,
      repositoryBase: $repositoryBase,
      workflowDefinitionSha256: $workflowDefinitionSha256,
      design: { path: $designPath, sha256: $designSha256 },
      ownershipReport: { path: $ownershipPath, sha256: $ownershipSha256 },
      sources: [
        { role: "questions", path: $questionsPath, sha256: $questionsSha256 },
        { role: "research", path: $researchPath, sha256: $researchSha256 }
      ],
      sourceSetSha256: $sourceSetSha256,
      designPolicy: {
        revision: "local.design-acceptance@1",
        sha256: $designAcceptancePolicySha256
      },
      promotionPolicy: {
        revision: "local.provenance-promotion@1",
        sha256: $promotionPolicySha256
      },
      structurePolicy: {
        revision: "local.structure@1",
        sha256: $structurePolicySha256
      },
      policies: {
        designBoundary: { ref: "local.design-boundary@1", sha256: $designPolicySha256 },
        impactRisk: { ref: "local.impact-risk@1", sha256: $impactPolicySha256 },
        structure: { ref: "local.structure@1", sha256: $structurePolicySha256 }
      }
    }' > "$temporary"
  mv -f "$temporary" "$output"
}

write_design_package() {
  local revision=$1
  local binding=$2
  local design=$3
  local ownership=$4
  local impact=$5
  local synthesis=$6
  local output=$7
  local temporary

  temporary=$(mktemp "${output%/*}/.design-package.XXXXXX")
  jq -n \
    --argjson revision "$revision" \
    --arg bindingPath "$binding" --arg bindingSha256 "$(sha256sum "$binding" | cut -d ' ' -f 1)" \
    --arg designPath "$design" --arg designSha256 "$(sha256sum "$design" | cut -d ' ' -f 1)" \
    --arg ownershipPath "$ownership" --arg ownershipSha256 "$(sha256sum "$ownership" | cut -d ' ' -f 1)" \
    --arg impactPath "$impact" --arg impactSha256 "$(sha256sum "$impact" | cut -d ' ' -f 1)" \
    --arg synthesisPath "$synthesis" --arg synthesisSha256 "$(sha256sum "$synthesis" | cut -d ' ' -f 1)" \
    '{
      contractVersion: 1,
      status: "ready_for_local_gate",
      designRevision: $revision,
      binding: { path: $bindingPath, sha256: $bindingSha256 },
      design: { path: $designPath, sha256: $designSha256 },
      ownershipReport: { path: $ownershipPath, sha256: $ownershipSha256 },
      impactReport: { path: $impactPath, sha256: $impactSha256 },
      synthesis: { path: $synthesisPath, sha256: $synthesisSha256 }
    }' > "$temporary"
  mv -f "$temporary" "$output"
}

run_design_loop() {
  local bead_id=$1
  local task_directory=$2
  local revision
  local design
  local boundary
  local impact
  local synthesis
  local binding
  local package
  local gate
  local promotion_request
  local promotion
  local verdict
  local response

  if stage_accepted "$task_directory" design; then
    printf 'skip design (accepted)\n'
    return 0
  fi
  if [[ "$dry_run" == true ]]; then
    run_stage "$bead_id" "$task_directory" design false
    run_repo_skill_step "$bead_id" "$task_directory" design-boundary-r1 design-boundary-reviewer "$task_directory/03-design-boundary-review-r1.md" "Return the exact Design Boundary Review output contract."
    run_repo_skill_step "$bead_id" "$task_directory" design-impact-r1 impact-risk-reviewer "$task_directory/03-design-impact-risk-review-r1.md" "Return the exact Impact and Risk Review output contract."
    run_repo_skill_step "$bead_id" "$task_directory" design-synthesis-r1 qrspi-design-structure "$task_directory/03-design-acceptance-synthesis-r1.md" "Synthesize the exact reports without approving the Design."
    run_repo_skill_step "$bead_id" "$task_directory" design-gate-r1 qrspi-design-structure "$task_directory/03-design-gate-response-r1.json" "Create the exact local gate response only after human approval."
    run_repo_skill_step "$bead_id" "$task_directory" design-promotion-r1 qrspi-design-structure "$task_directory/03-provenance-promotion-request-r1.json" "Construct the exact promotion request. An external adapter must return the authoritative result and immutable graph snapshot."
    return 0
  fi

  while true; do
    revision=$(revision_for "$task_directory" design)
    ((revision <= MAX_DESIGN_REVISIONS)) || fail "Design revision budget exhausted"
    if ! loop_checkpoint_accepted "$task_directory" "design-producer-r$revision"; then
      run_stage "$bead_id" "$task_directory" design false
      design=$(artifact_for_stage "$task_directory" design)
      [[ -f "$design" ]] || fail "Design producer did not leave a current Design artifact"
      record_loop_checkpoint "$task_directory" "design-producer-r$revision" "$design"
    fi
    design=$(artifact_for_stage "$task_directory" design)
    [[ -f "$design" ]] || fail "Design producer did not leave a current Design artifact"

    boundary="$task_directory/03-design-boundary-review-r$revision.md"
    run_repo_skill_step "$bead_id" "$task_directory" "design-boundary-r$revision" design-boundary-reviewer "$boundary" \
      "Review the exact current Design independently. Read the current ticket, complete one-hop Beads graph, accepted Questions and Research, and cited architecture. Return only the required report."
    verdict=$(markdown_verdict "$boundary")
    case "$verdict" in
      ScopeClean) ;;
      ReviseDesign)
        advance_revision "$task_directory" design "$design"
        continue
        ;;
      NeedsClarification)
        fail "Design boundary review requires human clarification: $boundary"
        ;;
      *) fail "invalid Design boundary verdict in $boundary: $verdict" ;;
    esac

    binding="$task_directory/03-design-acceptance-binding-r$revision.json"
    if ! loop_checkpoint_accepted "$task_directory" "design-binding-r$revision"; then
      write_design_binding "$bead_id" "$task_directory" "$revision" "$design" "$boundary" "$binding"
      record_loop_checkpoint "$task_directory" "design-binding-r$revision" "$binding"
    fi
    current_binding_sha=$(sha256sum "$binding" | cut -d ' ' -f 1)

    impact="$task_directory/03-design-impact-risk-review-r$revision.md"
    run_repo_skill_step "$bead_id" "$task_directory" "design-impact-r$revision" impact-risk-reviewer "$impact" \
      "Review the exact Design and authoritative local binding at $binding. Use the ownership report only for its bound identity and ScopeClean entry verdict; do not consume its conclusions. Return only the required report."
    verdict=$(markdown_verdict "$impact")
    case "$verdict" in
      ImpactReady|NeedsRiskDecision) ;;
      ReviseDesign)
        advance_revision "$task_directory" design "$design"
        continue
        ;;
      *) fail "invalid impact and risk verdict in $impact: $verdict" ;;
    esac

    synthesis="$task_directory/03-design-acceptance-synthesis-r$revision.md"
    run_repo_skill_step "$bead_id" "$task_directory" "design-synthesis-r$revision" qrspi-design-structure "$synthesis" \
      "Synthesize $boundary and $impact against $binding. Preserve every control, verification obligation, residual risk, and requested human decision. This is the explicitly authorized local-qrispi compatibility runner, not production Workflowd: exact local path/SHA identities and distinct OpenCode review invocations are its disclosed review evidence. Do not reject this local package solely because it lacks production Git-published ArtifactReferences, durable reviewer records, or authenticated transport; retain those as production implementation requirements and state the local limitation. If both reports permit the unchanged Design to proceed, prepare it for the local gate without approving it or manufacturing production authority."

    package="$task_directory/03-design-acceptance-package-r$revision.json"
    if ! loop_checkpoint_accepted "$task_directory" "design-package-r$revision"; then
      write_design_package "$revision" "$binding" "$design" "$boundary" "$impact" "$synthesis" "$package"
      record_loop_checkpoint "$task_directory" "design-package-r$revision" "$package"
    fi
    current_package_sha=$(sha256sum "$package" | cut -d ' ' -f 1)

    if [[ "$auto_approve" == false ]]; then
      printf '\nApprove exact Design package %s? [a]pprove, [r]evise Design, [s]top: ' "$current_package_sha"
      IFS= read -r response
      case "$response" in
        a|A|approve|APPROVE) ;;
        r|R|revise|REVISE)
          advance_revision "$task_directory" design "$design"
          continue
          ;;
        *) printf 'stopped at Design gate; rerun to resume\n'; return 2 ;;
      esac
    fi

    gate="$task_directory/03-design-gate-response-r$revision.json"
    run_repo_skill_step "$bead_id" "$task_directory" "design-gate-r$revision" qrspi-design-structure "$gate" \
      "Create a local gate response with top-level packageSha256 exactly $current_package_sha, top-level bindingSha256 exactly $current_binding_sha, and decision approve when the synthesis permits the unchanged Design to proceed. The human explicitly authorized the local runner to apply the recommended answer. Record every recommended control and residual-risk disposition explicitly. Disclose local auto-approval and do not claim production authentication, Git publication, or durable gate authority."
    jq -e --arg package "$current_package_sha" --arg binding "$current_binding_sha" \
      '.decision == "approve" and .packageSha256 == $package and .bindingSha256 == $binding' \
      "$gate" >/dev/null || fail "Design gate response is not bound to the exact package and scope: $gate"
    current_gate_sha=$(sha256sum "$gate" | cut -d ' ' -f 1)

    promotion_request="$task_directory/03-provenance-promotion-request-r$revision.json"
    run_repo_skill_step "$bead_id" "$task_directory" "design-promotion-r$revision" qrspi-design-structure "$promotion_request" \
      "Construct the exact local promotion request bound to package $current_package_sha and gate $current_gate_sha. Read $source_repo/scripts/run-local-provenance-promotion.sh and satisfy its request contract exactly: top-level requestKind ProvenancePromotionRequest, nonempty requestId and cliScope, top-level packageSha256 and gateResponseSha256, and selectionManifest arrays sourceIntents, requirementIntents, resolutionIntents, ruleIntents, and edgeIntents with the required canonical hashes and create shapes. The human-authorized local-qrispi compatibility gate permits submission to the configured local adapter while production authentication and authority remain explicitly unclaimed. Preserve all accepted requirements, decisions, controls, risks, verification obligations, and ownership. Do not create a promotion result or claim that publication occurred."
    jq -e --arg package "$current_package_sha" --arg gate "$current_gate_sha" \
      '.packageSha256 == $package and .gateResponseSha256 == $gate' \
      "$promotion_request" >/dev/null || fail "promotion request is not bound to the approved package and gate: $promotion_request"
    [[ -n "$PROMOTION_COMMAND" ]] || fail "Design promotion requires QRISPI_PROMOTION_COMMAND"
    [[ -x "$PROMOTION_COMMAND" ]] || fail "QRISPI_PROMOTION_COMMAND is not executable: $PROMOTION_COMMAND"
    promotion="$task_directory/03-provenance-promotion-result-r$revision.json"
    QRISPI_PROMOTION_REQUEST_PATH="$promotion_request" \
    QRISPI_PROMOTION_RESULT_PATH="$promotion" \
    QRISPI_PACKAGE_SHA256="$current_package_sha" \
    QRISPI_GATE_SHA256="$current_gate_sha" \
      "$PROMOTION_COMMAND"
    [[ -f "$promotion" ]] || fail "promotion adapter did not create $promotion"
    if ! jq -e --arg package "$current_package_sha" --arg gate "$current_gate_sha" '
      .status == "confirmed" and
      .packageSha256 == $package and
      .gateResponseSha256 == $gate and
      (.graphSnapshot.identity | type == "string" and length > 0) and
      (.graphSnapshot.sha256 | test("^[0-9a-f]{64}$"))
    ' "$promotion" >/dev/null; then
      fail "Design cannot release Structure without a confirmed immutable graph snapshot: $promotion"
    fi
    record_loop_checkpoint "$task_directory" "design-promotion-r$revision" "$promotion"
    record_acceptance "$task_directory" design "$promotion"
    return 0
  done
}

run_structure_loop() {
  local bead_id=$1
  local task_directory=$2
  local revision
  local structure
  local review
  local verdict
  local response
  local design_directory
  local -a scope_children=()

  if stage_accepted "$task_directory" structure; then
    printf 'skip structure (accepted)\n'
    return 0
  fi
  if [[ "$dry_run" == true ]]; then
    run_stage "$bead_id" "$task_directory" structure false
    run_repo_skill_step "$bead_id" "$task_directory" structure-scope-review-r1 structure-scope-reviewer "$task_directory/04-structure-scope-review-r1.md" "Independently estimate the accepted Structure and return the exact post-Structure scope-review contract."
    return 0
  fi
  if ! stage_accepted "$task_directory" design; then
    design_directory=$(inherited_design_directory_for "$bead_id") || \
      fail "Structure requires an accepted and promoted Design package"
    printf 'inherited accepted Design from %s\n' "$design_directory"
  fi

  while true; do
    revision=$(revision_for "$task_directory" structure)
    ((revision <= MAX_STRUCTURE_REVISIONS)) || fail "Structure revision budget exhausted"
    if ! loop_checkpoint_accepted "$task_directory" "structure-producer-r$revision"; then
      run_stage "$bead_id" "$task_directory" structure false
      structure=$(artifact_for_stage "$task_directory" structure)
      [[ -f "$structure" ]] || fail "Structure producer did not leave a current Structure artifact"
      record_loop_checkpoint "$task_directory" "structure-producer-r$revision" "$structure"
    fi
    structure=$(artifact_for_stage "$task_directory" structure)
    [[ -f "$structure" ]] || fail "Structure producer did not leave a current Structure artifact"

    review="$task_directory/04-structure-scope-review-r$revision.md"
    run_repo_skill_step "$bead_id" "$task_directory" "structure-scope-review-r$revision" structure-scope-reviewer "$review" \
      "Act as the single independent post-Structure scope reviewer. Review $structure against the current ticket, accepted Design, and repository baseline. Do not produce another Structure or read another scope review. Estimate all human-authored production, test, migration, configuration, and required documentation changes and return exactly FeatureFit, SplitFeature, PromoteToEpic, KeepLarge, or NeedsResearch. Do not mutate Beads, Plan, or implement."
    verdict=$(markdown_verdict "$review")
    case "$verdict" in
      FeatureFit|KeepLarge)
        if [[ "$auto_approve" == true ]]; then
          record_acceptance "$task_directory" structure "$structure"
          commit_delivery_changes "$bead_id" "Structure $bead_id"
          printf 'Structure scope review returned %s; auto-approved delivery records acceptance and continues to Plan\n' "$verdict"
          return 0
        fi
        printf '\nAccept Structure revision %s with %s? [a]ccept, [r]evise Structure, [d]esign revision, [s]top: ' "$revision" "$verdict"
        IFS= read -r response
        case "$response" in
          a|A|accept|ACCEPT)
            record_acceptance "$task_directory" structure "$structure"
            return 0
            ;;
          r|R|revise|REVISE)
            advance_revision "$task_directory" structure "$structure"
            ;;
          d|D|design|DESIGN)
            advance_revision "$task_directory" design "$(artifact_for_stage "$task_directory" design)"
            invalidate_stage_acceptance "$task_directory" design structure plan implementation
            run_design_loop "$bead_id" "$task_directory" || return $?
            advance_revision "$task_directory" structure "$structure"
            ;;
          *) printf 'stopped at Structure review; rerun to resume\n'; return 2 ;;
        esac
        ;;
      SplitFeature|PromoteToEpic)
        if [[ "$auto_approve" == true && "$recursive" == true ]]; then
          mapfile -t scope_children < <(child_ids_for "$bead_id")
          if ((${#scope_children[@]} == 0)); then
            create_scope_children "$bead_id" "$task_directory" "$structure" "$review" "structure-children-r$revision" "$task_directory/04-structure-children-r$revision.md"
            mapfile -t scope_children < <(child_ids_for "$bead_id")
          fi
          ((${#scope_children[@]} > 0)) || fail "scope review returned $verdict but no child Beads could be created from $review"
          record_acceptance "$task_directory" structure "$structure"
          commit_delivery_changes "$bead_id" "Structure scope split for $bead_id"
          printf 'Structure scope review returned %s and produced %d child Bead(s); accepting the parent Structure for recursive child delivery\n' "$verdict" "${#scope_children[@]}"
          return 0
        fi
        mapfile -t scope_children < <(child_ids_for "$bead_id")
        if ((${#scope_children[@]} > 0)); then
          record_acceptance "$task_directory" structure "$structure"
          printf 'Structure scope review returned %s and found %d child Bead(s); accepting the parent Structure for recursive child delivery\n' "$verdict" "${#scope_children[@]}"
          return 0
        fi
        printf 'Structure scope review returned %s; human action required: %s\n' "$verdict" "$review"
        return 2
        ;;
      NeedsResearch)
        printf 'Structure scope review requires more research: %s\n' "$review"
        return 2
        ;;
      *) fail "invalid Structure scope-review verdict in $review: $verdict" ;;
    esac
  done
}

child_ids_for() {
  local bead_id=$1
  "$BD_BIN" list --parent "$bead_id" --all --json | jq -r '.[] | select(.status != "closed") | .id'
}

ticket_status() {
  local bead_id=$1
  "$BD_BIN" show "$bead_id" --json | normalize_ticket | jq -r '.status'
}

run_children() {
  local parent_id=$1
  shift
  local -a child_ids=("$@")
  local -A handled=()
  local child_id
  local status
  local progress
  local handled_count=0

  printf 'recursive Structure: %s has %d open child Bead(s)\n' "$parent_id" "${#child_ids[@]}"
  while ((handled_count < ${#child_ids[@]})); do
    progress=false
    for child_id in "${child_ids[@]}"; do
      [[ -z "${handled[$child_id]:-}" ]] || continue
      status=$(ticket_status "$child_id")
      if [[ "$status" == closed || "$status" == in_progress ]] || is_ready "$child_id"; then
        run_bead "$child_id"
        handled[$child_id]=true
        ((handled_count += 1))
        progress=true
      fi
    done

    if [[ "$progress" == false ]]; then
      printf 'error: recursive child frontier for %s is blocked:\n' "$parent_id" >&2
      for child_id in "${child_ids[@]}"; do
        [[ -n "${handled[$child_id]:-}" ]] || printf '  bd show %s\n' "$child_id" >&2
      done
      return 1
    fi
  done
}

prepare_worktree() {
  local bead_id=$1
  local repository_name
  local branch="opencode/$bead_id"
  local worktree
  local current_branch

  repository_name=$(basename "$source_repo")
  worktree="$worktree_root/$repository_name-$bead_id"
  if [[ "$worktree_prepared" == true ]]; then
    [[ "$worktree_bead_id" == "$bead_id" ]] || fail "a recursive delivery run can use only one top-level worktree"
    return 0
  fi

  if [[ "$dry_run" == true ]]; then
    printf 'git fetch origin main\n'
    printf 'git worktree add %s from origin/main on %s\n' "$worktree" "$branch"
    active_repo=$worktree
    worktree_prepared=true
    worktree_bead_id=$bead_id
    return 0
  fi

  if [[ -d "$worktree" ]]; then
    git -C "$worktree" rev-parse --show-toplevel >/dev/null 2>&1 || fail "worktree path is not a Git worktree: $worktree"
    active_repo=$(realpath "$worktree")
    current_branch=$(git -C "$active_repo" branch --show-current)
    if [[ "$current_branch" != "$branch" ]]; then
      git -C "$active_repo" rev-parse --verify --quiet "$branch" >/dev/null || \
        git -C "$active_repo" branch "$branch"
      git -C "$active_repo" switch "$branch"
    fi
    printf 'adopt worktree: %s\n' "$active_repo"
    worktree_prepared=true
    worktree_bead_id=$bead_id
    return 0
  fi

  git -C "$source_repo" fetch origin
  mkdir -p "$worktree_root"
  if git -C "$source_repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$source_repo" worktree add "$worktree" "$branch"
  elif git -C "$source_repo" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git -C "$source_repo" worktree add -b "$branch" "$worktree" "origin/$branch"
  else
    git -C "$source_repo" worktree add -b "$branch" "$worktree" origin/main
  fi
  active_repo=$(realpath "$worktree")
  printf 'created worktree: %s\n' "$active_repo"
  worktree_prepared=true
  worktree_bead_id=$bead_id
}

run_bead() {
  local bead_id=$1
  local raw_ticket
  local ticket_json
  local title
  local status
  local task_directory
  local index
  local response
  local -a child_ids=()
  local delivery_bead_id

  if [[ -z "$delivery_root_id" ]]; then
    delivery_root_id=$bead_id
  fi
  delivery_bead_id=$delivery_root_id

  raw_ticket=$("$BD_BIN" show "$bead_id" --json) || fail "could not read Bead $bead_id"
  ticket_json=$(printf '%s\n' "$raw_ticket" | normalize_ticket) || fail "could not decode Bead $bead_id"
  [[ $(printf '%s\n' "$ticket_json" | jq -r '.id') == "$bead_id" ]] || fail "bd returned the wrong Bead for $bead_id"
  title=$(printf '%s\n' "$ticket_json" | jq -r '.title')
  status=$(printf '%s\n' "$ticket_json" | jq -r '.status')
  if [[ "$prepare_only" == false ]]; then
    case "$status" in
    open)
      is_ready "$bead_id" || fail "$bead_id is not ready; inspect blockers with: bd show $bead_id"
      ;;
    in_progress)
      ;;
    closed)
      printf 'skip %s (closed)\n' "$bead_id"
      return 0
      ;;
    *)
      fail "$bead_id has unsupported status: $status"
      ;;
    esac
  fi

  if [[ "$use_worktree" == true ]]; then
    prepare_worktree "$delivery_bead_id"
  else
    active_repo=$source_repo
  fi
  task_directory=$(task_directory_for "$bead_id" "$title")

  printf '\n%s: %s\n' "$bead_id" "$title"
  printf 'repository: %s\n' "$active_repo"
  printf 'task directory: %s\n' "$task_directory"

  if [[ "$dry_run" == false ]]; then
    write_ticket_snapshot "$task_directory" "$ticket_json"
    if [[ "$prepare_only" == false && "$status" == open && "$claim" == true ]]; then
      "$BD_BIN" update "$bead_id" --claim >/dev/null
    fi
  fi
  if [[ "$prepare_only" == true ]]; then
    return 0
  fi

  for index in "${!STAGES[@]}"; do
    ((index >= from_index && index <= to_index)) || continue
    case "${STAGES[$index]}" in
      design) run_design_loop "$bead_id" "$task_directory" || return $? ;;
      structure) run_structure_loop "$bead_id" "$task_directory" || return $? ;;
      *) run_stage "$bead_id" "$task_directory" "${STAGES[$index]}" || return $? ;;
    esac

    if [[ "$recursive" == true && "${STAGES[$index]}" == structure ]]; then
      mapfile -t child_ids < <(child_ids_for "$bead_id")
      if ((${#child_ids[@]} > 0)); then
        run_children "$bead_id" "${child_ids[@]}"
        close_split_parent "$bead_id"
        printf 'parent %s stops after Structure while child Beads carry implementation\n' "$bead_id"
        return 0
      fi
    fi
  done

  if [[ "$dry_run" == false && "$to_stage" == implementation ]]; then
    if [[ "$auto_approve" == true ]]; then
      commit_delivery_changes "$bead_id" "Complete $bead_id"
      "$BD_BIN" update "$bead_id" --notes "Completed through recursive local QRSPI delivery. Validation artifacts live under $task_directory." >/dev/null
      "$BD_BIN" close "$bead_id" --reason "Completed through recursive local QRSPI delivery." >/dev/null
      printf 'closed %s\n' "$bead_id"
      push_delivery_branch
    else
      printf '\nImplementation flow finished for %s. Close the Bead now? [y/N]: ' "$bead_id"
      IFS= read -r response
      if [[ "$response" == y || "$response" == Y || "$response" == yes || "$response" == YES ]]; then
        "$BD_BIN" close "$bead_id" --reason "Completed through the local human-gated QRISPI flow." >/dev/null
        printf 'closed %s\n' "$bead_id"
      else
        printf 'left %s in progress for review\n' "$bead_id"
      fi
    fi
  fi
}

for bead_id in "${bead_ids[@]}"; do
  run_bead "$bead_id"
done
