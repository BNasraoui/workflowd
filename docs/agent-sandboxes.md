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

The disposable shared server loads the exact artifact through `OPENCODE_CONFIG`
over its global configuration and uses fake model credentials. Tests execute
ordinary shell controls, force denied native and Code Mode calls, finish
compaction/title/transient-summary turns, and continue the
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

The v1 service also reads `~/.config/opencode/opencode.json` and rejects v2 agent
permissions. **Never edit that shared file for this installation.** Install the
fragment separately and select it only for `opencode2-server.service` through a
systemd drop-in. The pinned v2 server merges this file over its global config.

The coordinator already installed the byte-identical artifact from
`ac63e62829a18b2843fd4902b0441ebfa2b7d812`. For probe-only revisions, reuse
`~/.local/state/workflowd-sandbox-install-ac63e62829a18b2843fd4902b0441ebfa2b7d812`
as `SANDBOX_INSTALL_RECORD` and proceed to Verify from the new reviewed checkout;
do not reinstall or overwrite the original record. The commands below are for a
fresh installation and refuse to overwrite existing files.

```sh
set -eu
test -n "$REVIEWED_COMMIT"
test "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT"
git diff --exit-code -- deploy/opencode/sandbox.json
export SANDBOX_INSTALL_RECORD="$HOME/.local/state/workflowd-sandbox-install-$REVIEWED_COMMIT"
mkdir -m 700 "$SANDBOX_INSTALL_RECORD"
git show "$REVIEWED_COMMIT:deploy/opencode/sandbox.json" > "$SANDBOX_INSTALL_RECORD/sandbox.json"
sha256sum "$SANDBOX_INSTALL_RECORD/sandbox.json"
python3 - <<'PY'
import hashlib, json, os, pathlib, shutil
record = pathlib.Path(os.environ['SANDBOX_INSTALL_RECORD'])
shared = pathlib.Path.home() / '.config/opencode/opencode.json'
target = pathlib.Path.home() / '.config/workflowd/opencode2-sandbox-agent.json'
dropin = pathlib.Path.home() / '.config/systemd/user/opencode2-server.service.d/workflowd-sandbox.conf'
backup = record / 'opencode.before.json'
assert not backup.exists(), 'Use the existing installation record; do not overwrite its backup'
assert not target.exists() and not dropin.exists(), 'Existing installation requires operator review'
fragment = json.loads((record / 'sandbox.json').read_text())
assert list(fragment) == ['agents'] and list(fragment['agents']) == ['sandbox']
before = json.loads(shared.read_text())
assert 'sandbox' not in before.get('agents', {}), 'An existing sandbox definition requires operator review'
shutil.copy2(shared, backup)
backup.chmod(0o600)
(record / 'global-config.before.sha256').write_text(hashlib.sha256(shared.read_bytes()).hexdigest() + '\n')
target.parent.mkdir(parents=True, exist_ok=True)
with target.open('xb') as f:
    os.chmod(target, 0o600)
    f.write((record / 'sandbox.json').read_bytes())
dropin.parent.mkdir(parents=True, exist_ok=True)
with dropin.open('x') as f:
    f.write('[Service]\nEnvironment=OPENCODE_CONFIG=%h/.config/workflowd/opencode2-sandbox-agent.json\n')
assert shared.read_bytes() == backup.read_bytes(), 'Shared global config changed'
PY
systemctl --user daemon-reload
systemctl --user restart opencode2-server.service
```

## Verify (coordinator/operator only)

The probe below reads only the existing server's local HTTP authentication from
its process environment. It uses the selected provider's existing authentication;
it does not load or register model credentials. It creates three disposable
sessions, two location bridges and a local SSH/Dagger fixture, then removes them.
It acquires no GitHub Actions lease. Model refusal to attempt a requested tool is
inconclusive, not a passing confinement result. Native denial is requested through
the advertised `execute` tool: separate `tools.shell`, `tools.read` and `tools.write`
calls must each produce a nested execution error, zero completed native calls and
an untouched host canary. Direct forced native calls remain covered by the fixture.
Each negative prompt asks for one exact call, with failure expected and no search
or retry. Evidence is paginated newest-first, checked for ordering and duplicates,
and bounded by that prompt's message ID; recorded calls are chronological. Missing
boundaries stop verification. Completed nested Code Mode `search` is discovery
only and is permitted, as are calls to the session's own bridge. Any other
completed nested or top-level call fails verification. Discovery cannot replace
the exact-code denial: it must still complete with `metadata.error` and no nested
calls. The fixture includes a denial followed by 22 discovery calls across pages.

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=6G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  --setenv="SANDBOX_INSTALL_RECORD=$SANDBOX_INSTALL_RECORD" \
  /usr/bin/python3 - <<'PY'
import hashlib, os, pathlib, subprocess, uuid
unit = 'opencode2-server.service'
pid = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'], text=True).strip()
env = dict(item.split('=', 1) for item in pathlib.Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in item)
assert env.get('OPENCODE_DISABLE_PROJECT_CONFIG') in ('1', 'true')
binary = pathlib.Path(f'/proc/{pid}/exe')
assert hashlib.sha256(binary.read_bytes()).hexdigest() == '5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c'
record = pathlib.Path(os.environ['SANDBOX_INSTALL_RECORD'])
fragment = pathlib.Path.home() / '.config/workflowd/opencode2-sandbox-agent.json'
assert env.get('OPENCODE_CONFIG') == str(fragment), 'Executor did not select the v2-only fragment'
assert fragment.read_bytes() == (record / 'sandbox.json').read_bytes(), 'Installed fragment differs from reviewed artifact'
assert pathlib.Path('deploy/opencode/sandbox.json').read_bytes() == fragment.read_bytes(), 'Checkout artifact differs from installation'
shared = pathlib.Path.home() / '.config/opencode/opencode.json'
assert shared.read_bytes() == (record / 'opencode.before.json').read_bytes(), 'Shared global config changed'
verification = record / ('verification-' + uuid.uuid4().hex)
print('Probe evidence: ' + str(verification), flush=True)
probe_env = dict(os.environ, EVIDENCE_OPENCODE_URL='http://127.0.0.1:4097',
    EVIDENCE_OPENCODE_PASSWORD=env['OPENCODE_SERVER_PASSWORD'],
    EVIDENCE_OPENCODE_MODEL='zai-coding-plan/glm-5.3-flash',
    EVIDENCE_SANDBOX_ROOT=str(verification))
subprocess.run(['bun', 'scripts/evidence/agent-sandbox.mjs', '--probe-session-policy',
    '--expected-artifact', str(record / 'sandbox.json')], env=probe_env, check=True)
PY
```

Review `session-policy.json` and `probe.json` in the printed probe directory. Each
attempt keeps its own evidence, including the earlier inconclusive attempt. The
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

Remove only the dedicated fragment and its drop-in. The shared global configuration
stays untouched. Restart only after the owned sessions/bridges are quiescent.

```sh
set -eu
python3 - <<'PY'
import os, pathlib
record = pathlib.Path(os.environ['SANDBOX_INSTALL_RECORD'])
target = pathlib.Path.home() / '.config/workflowd/opencode2-sandbox-agent.json'
dropin = pathlib.Path.home() / '.config/systemd/user/opencode2-server.service.d/workflowd-sandbox.conf'
assert target.read_bytes() == (record / 'sandbox.json').read_bytes(), 'Installed fragment changed; review before rollback'
assert dropin.read_text() == '[Service]\nEnvironment=OPENCODE_CONFIG=%h/.config/workflowd/opencode2-sandbox-agent.json\n', 'Drop-in changed; review before rollback'
dropin.unlink()
target.unlink()
PY
systemctl --user daemon-reload
systemctl --user restart opencode2-server.service
systemctl --user is-active opencode2-server.service
```
