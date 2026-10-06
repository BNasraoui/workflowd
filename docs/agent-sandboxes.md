# Sandbox agent operator gate

Sandbox dispatch stays disabled until the remaining RPI implementation and live
verification finish. Installing this agent does not enable dispatch. The worker
must stop before changing production configuration or restarting its executor.

The reviewed fragment is `deploy/opencode/sandbox.json`. It adds only
`agents.sandbox`. It contains no model, credentials, default agent, global
permissions, MCP servers, or auxiliary-agent overrides. Project configuration
must remain disabled. Each future lease owns a distinct controller location and
one runtime bridge; the wildcard permission alone does not separate leases.

## Fixture gate

Run on mint, from the reviewed checkout, with the pinned beta-19242 binary on PATH:

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=6G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  "$(command -v bun)" test test/sandbox/permissions.e2e.test.ts
```

The disposable shared server uses the exact artifact globally and fake model
credentials. Tests execute ordinary shell controls, force denied native and Code
Mode calls, finish compaction/title/transient-summary turns, and continue the
sandbox afterwards. Two location bridges reach separate SSH/Dagger runners;
foreign calls and calls after removal/restart must fail. The production probe's
own orchestration is also tested against this real executor with scripted model
responses. Tests do not change the production server.

If confinement fails, retain its evidence and stop before installation. Do not
restrict ordinary auxiliary agents globally, enable project configuration, or
fall back to private per-run model credentials.

## Install (coordinator/operator only)

Set `REVIEWED_COMMIT` to the complete commit from the implementation handoff.
Review its fixture report and checks before running these commands. The current
runner-workflow pin is `5a4da56f5829e4fb3a5f64385cb164ec73f432d1`; this
agent-only installation does not change that pin.

```sh
test -n "$REVIEWED_COMMIT"
test "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT"
git diff --exit-code -- deploy/opencode/sandbox.json
export SANDBOX_INSTALL_RECORD="$HOME/.local/state/workflowd-sandbox-install-$REVIEWED_COMMIT"
mkdir -p "$SANDBOX_INSTALL_RECORD"
git show "$REVIEWED_COMMIT:deploy/opencode/sandbox.json" > "$SANDBOX_INSTALL_RECORD/sandbox.json"
sha256sum "$SANDBOX_INSTALL_RECORD/sandbox.json"
python3 - <<'PY'
import json, os, pathlib, shutil
record = pathlib.Path(os.environ['SANDBOX_INSTALL_RECORD'])
target = pathlib.Path.home() / '.config/opencode/opencode.json'
backup = record / 'opencode.before.json'
assert not backup.exists(), 'Use the existing installation record; do not overwrite its backup'
fragment = json.loads((record / 'sandbox.json').read_text())
assert list(fragment) == ['agents'] and list(fragment['agents']) == ['sandbox']
before = json.loads(target.read_text())
assert 'sandbox' not in before.get('agents', {}), 'An existing sandbox definition requires operator review'
shutil.copy2(target, backup)
backup.chmod(0o600)
after = json.loads(json.dumps(before))
after.setdefault('agents', {})['sandbox'] = fragment['agents']['sandbox']
temporary = target.with_name('opencode.workflowd-install.json')
with temporary.open('x') as f:
    os.chmod(temporary, target.stat().st_mode & 0o777)
    f.write(json.dumps(after, indent=2) + '\n')
    f.flush()
    os.fsync(f.fileno())
temporary.replace(target)
PY
systemctl --user restart opencode2-server.service
```

## Verify (coordinator/operator only)

The probe below reads only the existing server's local HTTP authentication from
its process environment. It uses the selected provider's existing authentication;
it does not load or register model credentials. It creates three disposable
sessions, two location bridges and a local SSH/Dagger fixture, then removes them.
It acquires no GitHub Actions lease. Model refusal to attempt a requested tool is
an inconclusive failure, not a passing confinement result.

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=6G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  --setenv="SANDBOX_INSTALL_RECORD=$SANDBOX_INSTALL_RECORD" \
  /usr/bin/python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess
unit = 'opencode2-server.service'
pid = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'], text=True).strip()
env = dict(item.split('=', 1) for item in pathlib.Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in item)
assert env.get('OPENCODE_DISABLE_PROJECT_CONFIG') in ('1', 'true')
binary = pathlib.Path(f'/proc/{pid}/exe')
assert hashlib.sha256(binary.read_bytes()).hexdigest() == '5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c'
record = pathlib.Path(os.environ['SANDBOX_INSTALL_RECORD'])
before = json.loads((record / 'opencode.before.json').read_text())
loaded = json.loads((pathlib.Path.home() / '.config/opencode/opencode.json').read_text())
installed = loaded['agents'].pop('sandbox')
assert installed == json.loads((record / 'sandbox.json').read_text())['agents']['sandbox']
if not loaded['agents'] and 'agents' not in before:
    del loaded['agents']
assert loaded == before, 'Configuration other than agents.sandbox changed'
probe_env = dict(os.environ, EVIDENCE_OPENCODE_URL='http://127.0.0.1:4097',
    EVIDENCE_OPENCODE_PASSWORD=env['OPENCODE_SERVER_PASSWORD'],
    EVIDENCE_OPENCODE_MODEL='zai-coding-plan/glm-5.3-flash',
    EVIDENCE_SANDBOX_ROOT=str(record / 'verification'))
subprocess.run(['bun', 'scripts/evidence/agent-sandbox.mjs', '--probe-session-policy',
    '--expected-artifact', str(record / 'sandbox.json')], env=probe_env, check=True)
PY
```

Review `verification/session-policy.json` and `verification/probe.json`. The
production probe verifies the loaded rules, distinct locations, ordinary shell
execution before/after, native refusal, successful own-bridge execution, foreign
refusal, completed compaction, import denial after continuation, and owned-resource
cleanup. The fixture provides deterministic adversarial title/summary and restart
coverage; the production probe uses the real selected model and never restarts the
shared executor itself. Resume the implementation worker with the installation
record and probe result. Keep dispatch disabled through phases 4B–4D.

## Roll back (coordinator/operator only)

Keep sandbox dispatch disabled. First confirm that all owned sandbox sessions are
idle/removed and their location bridges are absent, using the verification record.
If cleanup failed or another sandbox is active, resolve that custody before
removing its policy. Preserve the evidence directory.

This restores only the prior sandbox fragment, preserving unrelated concurrent
configuration changes. Restart only after the owned sessions/bridges are quiescent.

```sh
python3 - <<'PY'
import json, os, pathlib
record = pathlib.Path(os.environ['SANDBOX_INSTALL_RECORD'])
target = pathlib.Path.home() / '.config/opencode/opencode.json'
before = json.loads((record / 'opencode.before.json').read_text())
current = json.loads(target.read_text())
expected = json.loads((record / 'sandbox.json').read_text())['agents']['sandbox']
assert current.get('agents', {}).get('sandbox') == expected, 'Installed fragment changed; review before rollback'
current['agents'].pop('sandbox')
if 'sandbox' in before.get('agents', {}):
    current['agents']['sandbox'] = before['agents']['sandbox']
if not current['agents'] and 'agents' not in before:
    del current['agents']
temporary = target.with_name('opencode.workflowd-rollback.json')
with temporary.open('x') as f:
    os.chmod(temporary, target.stat().st_mode & 0o777)
    f.write(json.dumps(current, indent=2) + '\n')
    f.flush()
    os.fsync(f.fileno())
temporary.replace(target)
PY
systemctl --user restart opencode2-server.service
systemctl --user is-active opencode2-server.service
```
