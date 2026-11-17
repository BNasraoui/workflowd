#!/bin/bash
set -euo pipefail

# deploy/systemd/workflowd-gateway.service run as systemd runs it, on this runner: each command
# of the unit (ExecStartPre, ExecStart, ExecStop) is read from the unit file, with the variables
# of deploy/gateway.env.example filled in and substituted as systemd substitutes ${NAME}, and
# runs with the environment of that file alone. The state directory is made as owner step 7 of
# docs/runner-placement.md makes it, with the two noscope templates of deploy/noscope/. Shown:
# the gateway starts as the image's uid 10001 and writes its listening line; import-login, by
# `docker exec --interactive` with a fake login on standard input, writes the imported line and
# no value of the login; the unit's ExecStop ends the gateway with an exit code that the unit
# counts as a clean stop (0 or one of SuccessExitStatus=).

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
unit=$repository_root/deploy/systemd/workflowd-gateway.service
example=$repository_root/deploy/gateway.env.example
state=/var/lib/workflowd-gateway
image=workflowd-gateway:local
root=$(mktemp -d)
client=

fail() {
  echo "gateway unit: $*" >&2
  exit 1
}
cleanup() {
  if [[ -n $client ]]; then kill "$client" 2>/dev/null || true; fi
  docker rm -f workflowd-gateway >/dev/null 2>&1 || true
  sudo rm -rf "$state"
  rm -rf "$root"
}
trap cleanup EXIT

[[ ! -e $state ]] || fail "$state exists on this runner already"

# The example's variables, filled: the image that this job built (the unit pulls nothing), this
# runner's uid and gid as the daemon's and as tailscaled's, and a Service name of the fixture.
python3 - "$example" "$root/env" "$image" "$(id -u)" "$(id -g)" <<'PY'
import sys
example, out, image, uid, gid = sys.argv[1:]
values = {'<daemon-uid>': uid, '<daemon-gid>': gid, '<front-uid>': uid, '<front-gid>': gid,
          '<service-name>.<tailnet-name>.ts.net': 'gateway.fixture.ts.net'}
lines = []
for line in open(example).read().splitlines():
    if not line or line.startswith('#'):
        continue
    key, value = line.split('=', 1)
    if key == 'WORKFLOWD_GATEWAY_IMAGE':
        value = image
    for placeholder, filled in values.items():
        value = value.replace(placeholder, filled)
    if '<' in value:
        sys.exit(f'{key} keeps a placeholder')
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1]
    lines.append(f'{key}={value}')
open(out, 'w').write('\n'.join(lines) + '\n')
PY

# Each command of the unit's key $1, its words separated by \x1f, one command per line of $2: the
# continuation lines joined, the leading '-' (ignore failure) kept as its own first word, and
# ${NAME} replaced by the value of the environment file, as one word.
unit_commands() {
  python3 - "$unit" "$root/env" "$1" > "$2" <<'PY'
import re, shlex, sys
unit, env, wanted = sys.argv[1:]
values = dict(line.split('=', 1) for line in open(env).read().splitlines())
logical, pending = [], ''
for raw in open(unit).read().splitlines():
    line = pending + raw.strip()
    pending = ''
    if line.endswith('\\'):
        pending = line[:-1] + ' '
        continue
    logical.append(line)
for line in logical:
    if not line.startswith(wanted + '='):
        continue
    command = line.split('=', 1)[1]
    ignore = command.startswith('-')
    words = shlex.split(command.lstrip('-'))
    words = [re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}', lambda m: values[m.group(1)], word)
             for word in words]
    sys.stdout.write('\x1f'.join((['-'] if ignore else []) + words) + '\n')
PY
}
unit_commands ExecStartPre "$root/pre"
unit_commands ExecStart "$root/start"
unit_commands ExecStop "$root/stop"
[[ $(wc -l < "$root/start") == 1 ]] || fail "the unit has not one ExecStart"
[[ $(wc -l < "$root/stop") == 1 ]] || fail "the unit has not one ExecStop"
[[ $(tr '\037' ' ' < "$root/start") == *" --name workflowd-gateway "* ]] ||
  fail "ExecStart names no container workflowd-gateway"

# The environment of the unit's commands: the file's variables and a PATH.
environment=(env -i PATH=/usr/bin:/bin)
while IFS= read -r line; do environment+=("$line"); done < "$root/env"
run_line() {
  local -a words
  IFS=$'\x1f' read -r -a words <<< "$1"
  if [[ ${words[0]} == - ]]; then
    "${environment[@]}" "${words[@]:1}" >/dev/null 2>&1 || true
  else
    "${environment[@]}" "${words[@]}"
  fi
}

# Owner step 7: the state directory and the two noscope providers, owned by the image's user.
login=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["login"]["directory"])' \
  "$(grep '^WORKFLOWD_CAPABILITY_GATEWAY=' "$root/env" | cut -d= -f2-)")
[[ $login == "$state/login" ]] || fail "the example's login directory is $login"
sudo install -d -o 10001 -g 10001 -m 0711 "$state"
sudo install -d -o 10001 -g 10001 -m 0700 "$state/config" "$state/config/noscope" \
  "$state/config/noscope/providers"
sed "/^mint = /s|LOGIN_DIRECTORY|$login|" "$repository_root/deploy/noscope/provider-access.toml" \
  > "$root/provider-access.toml"
cp "$repository_root/deploy/noscope/run-capability.toml" "$root/run-capability.toml"
for name in run-capability provider-access; do
  sudo install -o 10001 -g 10001 -m 0600 "$root/$name.toml" "$state/config/noscope/providers/$name.toml"
done

# ExecStartPre, then ExecStart in the background, as systemd's main process.
while IFS= read -r line; do run_line "$line"; done < "$root/pre"
start=$(<"$root/start")
run_line "$start" > "$root/stdout" 2> "$root/stderr" &
client=$!
listening="listening $state/front/gateway.sock"
for _ in $(seq 1 120); do
  if grep -qxF "$listening" "$root/stdout"; then break; fi
  if ! kill -0 "$client" 2>/dev/null; then
    head -c 2000 "$root/stderr" >&2
    fail "the gateway ended before it listened"
  fi
  sleep 0.5
done
grep -qxF "$listening" "$root/stdout" || { head -c 2000 "$root/stderr" >&2; fail "no listening line"; }

# Each process of the container runs as uid 10001 and gid 10001. docker top needs the pid column.
docker top workflowd-gateway -eo pid,uid,gid,args | tail -n +2 > "$root/top"
[[ -s $root/top ]] || fail "the container has no process"
if awk '$2 != 10001 || $3 != 10001 { bad = 1 } END { exit !bad }' "$root/top"; then
  cat "$root/top" >&2
  fail "a process of the container runs as another user"
fi
# The control socket's directory has the daemon's group, mode 0710 (operator step 3).
[[ $(sudo stat -c '%u %g %a' "$state/control") == "10001 $(id -g) 710" ]] ||
  fail "the control directory is $(sudo stat -c '%u %g %a' "$state/control")"

# import-login, as owner step 8 runs it, with a fake login on standard input.
access=fixture-access-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
refresh=fixture-refresh-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"%s","expiresAt":%s,"scopes":["user:inference"]}}' \
  "$access" "$refresh" "$(( ($(date +%s) + 3600) * 1000 ))" > "$root/login.json"
status=0
docker exec --interactive workflowd-gateway \
  /bin/bun /app/src/capability-gateway-server.ts import-login claude \
  < "$root/login.json" > "$root/import.out" 2> "$root/import.err" || status=$?
if grep -qF -e "$access" -e "$refresh" "$root/import.out" "$root/import.err" "$root/stdout" "$root/stderr"; then
  fail "an output holds a value of the login"
fi
[[ $status == 0 ]] || { head -c 500 "$root/import.err" >&2; fail "import-login exited $status"; }
[[ $(<"$root/import.out") == "imported the claude login, owned by uid 10001" ]] ||
  fail "import-login wrote: $(head -c 200 "$root/import.out")"
[[ $(sudo stat -c '%u %a' "$login") == "10001 700" ]] || fail "the login directory is not the gateway's"

# ExecStop, then the end of the main process: its code is one that the unit counts as clean.
began=$(date +%s)
run_line "$(<"$root/stop")"
code=0
wait "$client" || code=$?
client=
took=$(( $(date +%s) - began ))
clean=$(python3 - "$unit" <<'PY'
import sys
codes = {'0'}
for line in open(sys.argv[1]).read().splitlines():
    if line.startswith('SuccessExitStatus='):
        codes.update(word for word in line.split('=', 1)[1].split() if word.isdigit())
print(' '.join(sorted(codes)))
PY
)
[[ " $clean " == *" $code "* ]] || fail "the stop ended the gateway with $code, not one of: $clean"
(( took < 15 )) || fail "the stop took ${took}s"
echo "gateway unit: started as uid 10001, imported a login, stopped with $code in ${took}s"
