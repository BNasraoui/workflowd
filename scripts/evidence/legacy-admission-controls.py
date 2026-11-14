#!/usr/bin/python3
"""Actual private-engine admission plus isolated stale/writable/tampered refusals."""
import json
from pathlib import Path
import subprocess
import tempfile

output = Path('/evidence/legacy-admission')
output.mkdir()
admit = '/work/scripts/evidence/legacy-admit.py'
results = []


def run(name, command, expected, message=None, cwd='/work'):
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=30)
    (output / (name + '.stdout')).write_text(result.stdout)
    (output / (name + '.stderr')).write_text(result.stderr)
    assert result.returncode == expected, name
    if message:
        assert message in result.stderr, name
    results.append({'name': name, 'command': list(command), 'exit': result.returncode, 'expectedExit': expected})
    return result.stdout


accepted = json.loads(run('matching-private-images', ['python3', admit], 0))
assert set(accepted) == {'tooling', 'runner', 'engine'}
base = 'sha256:69f919497cada9a8611f3de61df902d9f94bf20f84552ef5bd93125c38608ef9'
inventory = subprocess.check_output(['docker', 'run', '--rm', '--network=none', '--memory=128m', '--memory-swap=128m', '--cpus=1', '--pids-limit=32', '--entrypoint=dpkg-query', base, '-W'], timeout=20)
(output / 'base-installed.txt').write_bytes(inventory)
with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    (directory / 'deploy/sandbox').mkdir(parents=True)
    (directory / 'deploy/sandbox/Containerfile').write_text('stale source')
    run('stale-source', ['python3', admit], 1, 'Stale fixture image source', cwd=temporary)
    record = directory / 'record.json'
    record.write_bytes(Path('/source/legacy/fixture.json').read_bytes())
    command = ['unshare', '--mount', '--propagation', 'private', 'sh', '-ec',
               'mount --bind "$1" /source/legacy/fixture.json; exec python3 "$2"', '_', str(record), admit]
    run('writable-binding', command, 1, 'Image binding must be outside writable evidence')
    record.write_text('{}')
    command[6] = 'mount --bind "$1" /source/legacy/fixture.json; mount -o remount,bind,ro /source/legacy/fixture.json; exec python3 "$2"'
    run('changed-readonly-record', command, 1, 'Fixture record digest differs')
(output / 'results.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'admissionControlsPassed': len(results)}))
