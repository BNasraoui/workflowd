#!/usr/bin/python3
"""Stage only deterministic controller tools/packages in the owned offline engine."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

assert os.environ.get('WORKFLOWD_TEST_RESOURCE_CONFIG'), 'Resource preload required'
assert not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT')
repo = Path('/work')
output = Path('/evidence/controller-build')
output.mkdir()


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, timeout=1000)
    name = output / ('command-' + str(len(list(output.glob('command-*.json')))))
    name.with_suffix('.stdout').write_bytes(result.stdout)
    name.with_suffix('.stderr').write_bytes(result.stderr)
    name.with_suffix('.json').write_text(json.dumps({'command': ['docker', *args], 'exit': result.returncode}))
    assert result.returncode == 0, 'Private controller stage failed: ' + str(name)
    return result.stdout.decode().strip()


base = json.loads(Path('/evidence/controller-image.json').read_text())[0]
assert base['Id'] == Path('/evidence/systemd-image-id').read_text().strip()
assert json.loads(docker('image', 'inspect', base['Id']))[0]['RootFS'] == base['RootFS']
alias = 'workflowd-controller-input:sha256-' + base['Id'].split(':')[1]
docker('tag', base['Id'], alias)
assert json.loads(docker('image', 'inspect', alias))[0]['Id'] == base['Id']
context = output / 'context'
context.mkdir()
shutil.copytree('/source/legacy/apt-inputs', context / 'apt-inputs')
shutil.copyfile(repo / 'scripts/evidence/legacy-offline.sh', context / 'install.sh')
tools = {}
for source, destination in [('docker-client', '/usr/bin/docker'), ('docker-buildx', '/usr/local/libexec/docker/cli-plugins/docker-buildx')]:
    shutil.copyfile('/evidence/' + source, context / source)
    tools[destination] = sha(context / source)
inputs = {str(path.relative_to(context)): sha(path) for path in sorted(context.rglob('*')) if path.is_file()}
dockerfile = f'''FROM {alias}
COPY apt-inputs /opt/workflowd-controller/apt-inputs
COPY install.sh /opt/workflowd-controller/install.sh
RUN test "$(id -u)" = 0 && test ! -S /var/run/docker.sock && test ! -S /run/systemd/private && \
    WORKFLOWD_LEGACY_MIRROR=/opt/workflowd-controller/apt-inputs sh /opt/workflowd-controller/install.sh git openssh-client zip unzip && \
    rm -rf /opt/workflowd-controller
COPY --chmod=0755 docker-client /usr/bin/docker
COPY --chmod=0755 docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
'''
(context / 'Containerfile').write_text(dockerfile)
docker('build', '--network=none', '--memory=512m', '--memory-swap=512m',
       '--iidfile', str(output / 'image-id'), '-f', str(context / 'Containerfile'), str(context))
identifier = (output / 'image-id').read_text().strip()
image = json.loads(docker('image', 'inspect', identifier))[0]
assert image['RootFS']['Layers'][:len(base['RootFS']['Layers'])] == base['RootFS']['Layers']
# This image has never booted a manager, created a bus, run SSH/MCP, or received
# any runtime owner/namespace/environment. Only Dockerfile package/tool steps ran.
(output / 'installed.txt').write_text(docker('run', '--rm', '--network', 'none',
    '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64',
    '--entrypoint', 'dpkg-query', identifier, '-W'))
docker('image', 'save', '--output', '/evidence/controller-built.tar', identifier)
sources = {name: sha(repo / name) for name in ['scripts/evidence/legacy-controller-build.py',
    'scripts/evidence/legacy-offline.sh', 'scripts/evidence/legacy-controller-inputs.json',
    'scripts/evidence/legacy-build.mjs', 'scripts/evidence/legacy-outer.sh']}
manifest = dict(version=1, baseReference='docker.io/jrei/systemd-ubuntu@sha256:e791df994db59412c5989ea2998842db1844d7c5ebaf759bf0ee02caf8cc4c56',
                base=base, image=image, sources=sources, inputs=inputs, tools=tools,
                dockerfileSha256=sha(context / 'Containerfile'))
Path('/evidence/controller-fixture.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'controllerImage': identifier, 'offline': True}))
