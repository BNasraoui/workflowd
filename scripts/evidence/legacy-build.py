#!/usr/bin/python3
"""Actual offline fixture builds; launched beneath the unchanged resource preload."""
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

repo = Path('/work')
output = Path('/evidence/legacy-build')
output.mkdir()
spec = importlib.util.spec_from_file_location('images', repo / 'scripts/evidence/legacy-images.py')
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)
assert os.environ.get('WORKFLOWD_TEST_RESOURCE_CONFIG'), 'Resource preload required'
assert not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT')


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, timeout=1000)
    index = len(list(output.glob('command-*.json')))
    name = output / ('command-' + str(index))
    name.with_suffix('.stdout').write_bytes(result.stdout)
    name.with_suffix('.stderr').write_bytes(result.stderr)
    name.with_suffix('.json').write_text(json.dumps({'command': ['docker', *args], 'exit': result.returncode}))
    assert result.returncode == 0, 'Private Docker build command failed: ' + str(name)
    return result.stdout.decode().strip()


def replace(text, before, after):
    assert text.count(before) == 1, 'Unexpected Dockerfile; refusing offline adaptation'
    return text.replace(before, after)


roots = {}
for root, expected in images.ROOTS.items():
    name = expected['name']
    metadata = json.loads(Path('/source/legacy/' + name + '.json').read_text())[0]
    images.verify_archive(root, Path('/source/legacy/' + name + '.tar'), metadata)
    roots[root] = metadata
images.verify_loaded(roots, lambda image: json.loads(docker('image', 'inspect', image))[0])
(output / 'input-verification.json').write_text(json.dumps({'roots': roots, 'archivesAndLayersVerified': True}, indent=2))

# BuildKit's FROM resolver needs an image name. This private, content-named alias
# is verified against the approved configuration immediately before the build;
# it is not a mutable-tag fallback or a production pin override.
ubuntu = next(iter(images.ROOTS.values()))['id']
alias = 'workflowd-fixture-input:sha256-' + ubuntu.split(':')[1]
docker('tag', ubuntu, alias)
assert json.loads(docker('image', 'inspect', alias))[0]['Id'] == ubuntu
sources = {}
for name in ['deploy/sandbox/Containerfile', 'test/sandbox/fixtures/runner.Containerfile',
             'deploy/sandbox/result.py', 'deploy/sandbox/publication-unicode.json', 'deploy/sandbox/casefold.json',
             'scripts/evidence/legacy-images.py', 'scripts/evidence/legacy-offline.sh', 'scripts/evidence/legacy-build.py']:
    sources[name] = hashlib.sha256((repo / name).read_bytes()).hexdigest()

built = {}
for kind, source, context in [('tooling', 'deploy/sandbox/Containerfile', 'deploy/sandbox'),
                              ('runner', 'test/sandbox/fixtures/runner.Containerfile', 'test/sandbox/fixtures')]:
    directory = output / kind
    shutil.copytree(repo / context, directory)
    offline = directory / '.workflowd-offline'
    shutil.copytree('/source/legacy/apt-inputs', offline / 'apt-inputs')
    shutil.copyfile('/source/legacy/container-use.tar.gz', offline / 'container-use.tar.gz')
    shutil.copyfile(repo / 'scripts/evidence/legacy-offline.sh', offline / 'install.sh')
    original = (repo / source).read_text()
    text = original
    if kind == 'tooling':
        text = replace(text, 'FROM ' + next(iter(images.ROOTS)), 'FROM ' + alias)
        start = 'RUN apt-get update \\\n    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\\n       ca-certificates curl git python3'
        text = replace(text, start, 'COPY .workflowd-offline /opt/workflowd-offline\nRUN sh /opt/workflowd-offline/install.sh ca-certificates curl git python3')
        start = "curl -fsSL --proto '=https' --proto-redir '=https' \\\n       https://github.com/dagger/container-use/releases/download/v0.4.2/container-use_v0.4.2_linux_amd64.tar.gz -o /tmp/cu.tgz"
        text = replace(text, start, 'cp /opt/workflowd-offline/container-use.tar.gz /tmp/cu.tgz')
    else:
        assert json.loads(docker('image', 'inspect', 'workflowd-sandbox-tooling:fixture'))[0]['Id'] == built['tooling']['Id']
        start = 'RUN apt-get update \\\n    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server python3 iptables \\\n       iproute2 iputils-ping'
        text = replace(text, start, 'RUN sh /opt/workflowd-offline/install.sh openssh-server python3 iptables iproute2 iputils-ping')
    (directory / 'Containerfile').write_text(text)
    (output / (kind + '.diff')).write_text(''.join(difflib.unified_diff(original.splitlines(True), text.splitlines(True), fromfile=source, tofile=str(directory / 'Containerfile'))))
    docker('build', '--network=none', '--memory=512m', '--memory-swap=512m',
           '-t', 'workflowd-sandbox-' + kind + ':fixture', '-f', str(directory / 'Containerfile'), str(directory))
    built[kind] = json.loads(docker('image', 'inspect', 'workflowd-sandbox-' + kind + ':fixture'))[0]
    assert built[kind]['RootFS']['Layers'][:len(roots[next(iter(images.ROOTS))]['RootFS']['Layers'])] == roots[next(iter(images.ROOTS))]['RootFS']['Layers']
    (output / (kind + '-installed.txt')).write_text(docker('run', '--rm', '--network', 'none', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64', '--entrypoint', 'dpkg-query', built[kind]['Id'], '-W'))
runner = built['runner']['Id']
proof = docker('run', '--rm', '--network', 'none', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64', '--entrypoint', 'sh', runner, '-ec',
               'test "$(git log -1 --format=%an)" = "Workflowd Agent"; test "$(git log -1 --format=%ae)" = agent@workflowd.invalid; test "$(git config user.name)" = "Workflowd Agent"; python3 -B -c "import unicodedata; assert unicodedata.unidata_version == \'15.0.0\'; print(unicodedata.unidata_version)"; /usr/sbin/sshd -T | grep -E "^(strictmodes|hostkey) "')
(output / 'runner-prerequisite.txt').write_text(proof)
docker('image', 'save', '--output', '/evidence/legacy-built.tar', built['tooling']['Id'], runner)
manifest = {'version': 1, 'roots': roots, 'images': built, 'sources': sources}
Path('/evidence/legacy-fixture.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'built': {k: v['Id'] for k, v in built.items()}, 'offline': True}))
