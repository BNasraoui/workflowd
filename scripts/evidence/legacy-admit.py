#!/usr/bin/python3
"""Admit only trusted, readonly, source-matching prebuilt legacy fixture artifacts."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

assert os.environ['WORKFLOWD_SANDBOX_PREBUILT'] == '1'
assert os.environ.get('WORKFLOWD_TEST_RESOURCE_CONFIG'), 'Resource preload required'
assert not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT')
path = Path('/source/legacy/fixture.json')
assert path.resolve() == path and not path.is_symlink()
mounts = [line.split(' - ')[0].split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
mount = max((row for row in mounts if str(path) == row[4] or str(path).startswith(row[4].rstrip('/') + '/')), key=lambda row: len(row[4]))
assert 'ro' in mount[5].split(','), 'Image binding must be outside writable evidence'
data = path.read_bytes()
assert len(data) <= 1048576 and hashlib.sha256(data).hexdigest() == path.with_suffix('.sha256').read_text().strip(), 'Fixture record digest differs'
record = json.loads(data)
assert set(record) == {'version', 'roots', 'images', 'sources'} and record['version'] == 1
assert set(record['sources']) == {'deploy/sandbox/Containerfile', 'test/sandbox/fixtures/runner.Containerfile',
                                'deploy/sandbox/result.py', 'deploy/sandbox/publication-unicode.json', 'deploy/sandbox/casefold.json',
                                'scripts/evidence/legacy-images.py', 'scripts/evidence/legacy-offline.sh', 'scripts/evidence/legacy-build.py'}
for name, digest in record['sources'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest, 'Stale fixture image source: ' + name
spec = importlib.util.spec_from_file_location('images', 'scripts/evidence/legacy-images.py')
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)
images.verify_loaded(record['roots'], images.inspect)
assert set(record['images']) == {'tooling', 'runner'}
result = {'engine': images.ROOTS[next(root for root in images.ROOTS if root.startswith('registry.dagger.io/'))]['id']}
for name, expected in record['images'].items():
    assert re.fullmatch('sha256:[a-f0-9]{64}', expected['Id'])
    actual = images.inspect(expected['Id'])
    assert actual['Id'] == expected['Id'] and actual['RootFS'] == expected['RootFS'] and actual['Config'] == expected['Config']
    result[name] = expected['Id']
print(json.dumps(result))
