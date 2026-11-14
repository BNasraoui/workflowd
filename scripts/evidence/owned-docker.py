#!/usr/bin/python3
"""Scoped host launcher for the explicitly approved P2 owned Docker backend.

Only this trusted launcher sees the host socket. Tests and their resource guard
belong inside the owned outer container, against its private inner daemon.
"""
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.request
import io
import tarfile
import fcntl

IMAGE = 'docker.io/library/docker@sha256:97545b7bab66319a476800a85b008b25c06681733d484909e2a776281e41574f'
PYTHON = 'docker.io/library/python@sha256:53739acebd52a300f19f52d93f2a6165f63300689bdf6f8af2bff0d63780e5e6'
PYTHON312 = 'docker.io/library/python@sha256:ba94b66cc4fee436c27cbc42a6e315ead60729e8d2f109e3606a9d1bdba7bf0e'
NIX = 'docker.io/nixos/nix@sha256:c7cc6c8cb5d81bed19997247629604708fda95c99c43ac362daa05b6a68e8a24'
DAGGER = 'registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36'
SYSTEMD = 'docker.io/jrei/systemd-ubuntu@sha256:e791df994db59412c5989ea2998842db1844d7c5ebaf759bf0ee02caf8cc4c56'
LEGACY_UBUNTU = 'docker.io/library/ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55'
NATS = 'docker.io/library/nats@sha256:9e5633ac7584fc4e80d34be3ff7e15aa3fabec79a5573c2d9abefcf1f7761d9a'
ALPINE = 'docker.io/library/alpine@sha256:c64c687cbea9300178b30c95835354e34c4e4febc4badfe27102879de0483b5e'
LABEL = 'io.workflowd.fixture.owner'
ENDPOINT = 'unix:///var/run/docker.sock'
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}
LIMITS = ['-p', 'MemoryMax=6G', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=200%', '-p', 'TasksMax=1024']
LEGACY_LOGS = ('daemon.log', 'readiness.log', 'legacy.log', 'systemd-load.log',
               'ubuntu-load.log', 'dagger-load.log', 'built-load.log', 'controller-setup.log',
               'legacy-admission.log', 'legacy-test.log', 'legacy-build.log',
               'legacy-phases.log', 'diagnostic-files.log')


def prepare_legacy_logs(runtime):
    # Collector-owned from creation: a root writer may die before shutdown repair.
    # These empty private logs never establish readiness or custody.
    for name in LEGACY_LOGS:
        descriptor = os.open(runtime / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)


def save(path, value):
    temporary = path.with_suffix('.next')
    with temporary.open('w') as output:
        json.dump(value, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def docker(root, *args, timeout=30, check=True, deadline=None):
    command = ['/usr/bin/docker', '--host', ENDPOINT, '--config', str(root / 'docker-config'), *args]
    receipt = root / ('command-' + uuid.uuid4().hex + '.json')
    started, clock = time.time(), time.monotonic()
    save(receipt, {'command': command, 'started': started})
    if deadline is not None:
        timeout = min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            raise RuntimeError('Owned Docker cleanup budget exhausted; custody retained')
    try:
        result = subprocess.run(command, env=ENV, capture_output=True, timeout=timeout)
        receipt.with_suffix('.stdout').write_bytes(result.stdout)
        receipt.with_suffix('.stderr').write_bytes(result.stderr)
        save(receipt, {'command': command, 'started': started, 'exit': result.returncode,
                       'finished': time.time(), 'elapsed': time.monotonic() - clock})
        if check and result.returncode != 0:
            raise RuntimeError('Owned Docker command failed; see ' + str(receipt))
        return result
    except subprocess.TimeoutExpired as error:
        receipt.with_suffix('.stdout').write_bytes(error.stdout or b'')
        receipt.with_suffix('.stderr').write_bytes(error.stderr or b'')
        save(receipt, {'command': command, 'started': started, 'timeout': timeout,
                       'finished': time.time(), 'elapsed': time.monotonic() - clock})
        raise


def cleanup(root):
    # Main and independent reaper share only an exact-invocation lock. Reread
    # inventories after acquiring it: a prior receipt never proves later absence.
    started = time.monotonic()
    with (root / 'cleanup.lock').open('a') as lock:
        while True:
            if time.monotonic() >= started + 25:
                raise RuntimeError('Exact-owner cleanup busy; custody retained')
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(.1)
        cleanup_locked(root, started + 45)


def cleanup_locked(root, deadline):
    ledger = json.loads((root / 'ledger.json').read_text())
    owner = ledger['owner']
    assert re.fullmatch('[a-f0-9]{32}', owner)
    selector = LABEL + '=' + owner
    def command(*args, **kwargs):
        return docker(root, *args, deadline=deadline, **kwargs)

    # Exact-owner recovery also covers a lost create response; never enumerate
    # all of Mint's resources or let Bun's guardian see this daemon.
    ids, volumes = [], []
    for attempt in range(2):
        for identifier in command('container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'label=' + selector).stdout.decode().split():
            assert re.fullmatch('[a-f0-9]{64}', identifier)
            assert ledger.get('containerId', identifier) == identifier
            value = json.loads(command('container', 'inspect', '--format', '{"name":{{json .Name}},"labels":{{json .Config.Labels}}}', identifier).stdout)
            assert value['name'] == '/' + ledger['name'] and value['labels'][LABEL] == owner
            command('container', 'stop', '--time', '5', identifier, timeout=10)
            command('container', 'wait', identifier, timeout=10)
            state = json.loads(command('container', 'inspect', '--format', '{{json .State}}', identifier).stdout)
            assert state['Running'] is False
            save(root / ('stopped-' + identifier + '.json'), state)
            command('container', 'rm', identifier, timeout=10)
            ids.append(identifier)
        retry = False
        for name in command('volume', 'ls', '--quiet', '--filter', 'label=' + selector).stdout.decode().split():
            assert name == ledger['volume']
            labels = json.loads(command('volume', 'inspect', '--format', '{{json .Labels}}', name).stdout)
            assert labels[LABEL] == owner
            result = command('volume', 'rm', name, timeout=10, check=False)
            if result.returncode != 0:
                # Recognize only the observed late-attachment response. Its IDs
                # are never deletion authority: the next pass relists/readbacks.
                in_use = re.fullmatch(rb'Error response from daemon: remove ' + re.escape(name.encode()) + rb': volume is in use - \[[a-f0-9]{64}(?: [a-f0-9]{64})*\]\n?', result.stderr)
                if attempt == 0 and result.returncode == 1 and in_use:
                    retry = True
                    break
                raise RuntimeError('Owned Docker volume removal failed; custody and command receipts retained')
            volumes.append(name)
        if not retry:
            break
    networks = command('network', 'ls', '--quiet', '--no-trunc', '--filter', 'label=' + selector).stdout.decode().split()
    for identifier in networks:
        assert re.fullmatch('[a-f0-9]{64}', identifier)
        value = json.loads(command('network', 'inspect', identifier).stdout)[0]
        assert value['Name'] == ledger['name'] + '-build' and value['Labels'][LABEL] == owner
        command('network', 'rm', identifier, timeout=10)
    remaining = command('container', 'ls', '--all', '--quiet', '--filter', 'label=' + selector).stdout.strip()
    remaining_volumes = command('volume', 'ls', '--quiet', '--filter', 'label=' + selector).stdout.strip()
    remaining_networks = command('network', 'ls', '--quiet', '--filter', 'label=' + selector).stdout.strip()
    if remaining or remaining_volumes or remaining_networks:
        raise RuntimeError('Owned Docker cleanup unconfirmed')
    if time.monotonic() >= deadline:
        raise RuntimeError('Owned Docker cleanup budget exhausted; custody retained')
    save(root / ('cleanup-' + uuid.uuid4().hex + '.json'), {'owner': owner, 'containersRemoved': ids, 'volumesRemoved': volumes, 'networksRemoved': networks, 'confirmed': True})


def probe(root):
    ledger = json.loads((root / 'ledger.json').read_text())
    runtime = root / 'runtime'
    build = ledger['case'] == 'image'
    image = NIX if build else IMAGE
    native_mount = []
    if ledger['case'] == 'native':
        with open(ledger['agentArchive'], 'rb') as archive:
            assert hashlib.file_digest(archive, 'sha256').hexdigest() == ledger['agentArchiveSHA256']
        native_mount = ['--mount', 'type=bind,src=' + ledger['agentArchive'] + ',dst=/agent-image.tar,readonly']
    # The immutable public base is a cached build input, never a shared mutable
    # tag and never removed by fixture cleanup. Mutable resources carry owner labels.
    docker(root, 'image', 'pull', image, timeout=100)
    if ledger['case'] in ['systemd', 'systemd-death', 'legacy-build', 'legacy-test']:
        if not ledger.get('legacyController'):
            docker(root, 'image', 'pull', SYSTEMD, timeout=60)
            docker(root, 'image', 'save', '--output', str(runtime / 'systemd-image.tar'), SYSTEMD, timeout=30)
            (runtime / 'systemd-image-id').write_bytes(docker(root, 'image', 'inspect', '--format', '{{.Id}}', SYSTEMD).stdout)
        if ledger.get('systemdSuite') == 'legacy-inputs':
            for name, reference in [('legacy-ubuntu', LEGACY_UBUNTU), ('legacy-dagger', DAGGER)]:
                docker(root, 'image', 'pull', reference, timeout=60)
                docker(root, 'image', 'save', '--output', str(runtime / (name + '.tar')), reference, timeout=30)
                (runtime / (name + '.json')).write_bytes(docker(root, 'image', 'inspect', reference).stdout)
        if ledger.get('systemdSuite') == 'nats':
            docker(root, 'image', 'pull', NATS, timeout=60)
            docker(root, 'image', 'save', '--output', str(runtime / 'nats-image.tar'), NATS, timeout=30)
            (runtime / 'nats-image-id').write_bytes(docker(root, 'image', 'inspect', '--format', '{{.Id}}', NATS).stdout)
        if ledger.get('systemdSuite') == 'resources':
            docker(root, 'image', 'pull', ALPINE, timeout=60)
            docker(root, 'image', 'save', '--output', str(runtime / 'alpine-image.tar'), ALPINE, timeout=30)
            (runtime / 'alpine-image-id').write_bytes(docker(root, 'image', 'inspect', '--format', '{{.Id}}', ALPINE).stdout)
    if ledger['case'] == 'native':
        docker(root, 'image', 'pull', PYTHON312, timeout=60)
        docker(root, 'image', 'save', '--output', str(runtime / 'python312-image.tar'), PYTHON312, timeout=30)
    if ledger['case'] in ['dagger', 'dagger-network']:
        docker(root, 'image', 'pull', DAGGER, timeout=90)
        docker(root, 'image', 'save', '--output', str(runtime / 'dagger-image.tar'), DAGGER, timeout=30)
        (runtime / 'dagger-image-id').write_bytes(docker(root, 'image', 'inspect', '--format', '{{.Id}}', DAGGER).stdout)
        docker(root, 'image', 'pull', PYTHON, timeout=30)
        docker(root, 'image', 'save', '--output', str(runtime / 'python-image.tar'), PYTHON, timeout=30)
        url = 'https://github.com/dagger/dagger/releases/download/v0.18.14/dagger_v0.18.14_linux_amd64.tar.gz'
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read(128 * 1048576)
        assert hashlib.sha256(content).hexdigest() == '081329716be3bbf76a35b77d8c21d433bef9dce5efee43d6e91ba88be192b6e3'
        with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as archive:
            member = archive.getmember('dagger')
            assert member.isfile() and member.size < 200 * 1048576
            binary = archive.extractfile(member).read()
        assert hashlib.sha256(binary).hexdigest() == '4ff971589c296ae704c07b5538237f69bed7f3c1a3c2645dda043c9db6584610'
        (root / 'source/dagger').write_bytes(binary)
        (root / 'source/dagger').chmod(0o555)
    if ledger['case'] == 'container':
        docker(root, 'image', 'save', '--output', str(runtime / 'input-image.tar'), IMAGE, timeout=60)
    if ledger['case'] in ['network', 'dagger-network']:
        for package in json.loads((root / 'source/owned-network-inputs.json').read_text()):
            url = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/' + package['file']
            with urllib.request.urlopen(url, timeout=10) as response:
                content = response.read(2 * 1048576)
            assert hashlib.sha256(content).hexdigest() == package['sha256']
            (root / 'source/packages' / package['file']).write_bytes(content)
        docker(root, 'image', 'pull', PYTHON, timeout=60)
        docker(root, 'image', 'save', '--output', str(runtime / 'python-image.tar'), PYTHON, timeout=30)
    if time.time() > ledger['created'] + 110:
        raise RuntimeError('Startup budget exhausted before container creation')
    docker(root, 'volume', 'create', '--label', LABEL + '=' + ledger['owner'], ledger['volume'])
    network = 'none'
    if build:
        network = ledger['name'] + '-build'
        ledger['networkId'] = docker(root, 'network', 'create', '--label', LABEL + '=' + ledger['owner'], network).stdout.decode().strip()
        save(root / 'ledger.json', ledger)
    created = docker(root, 'container', 'create', '--name', ledger['name'],
        '--label', LABEL + '=' + ledger['owner'], *([] if build else ['--privileged']), '--init',
        '--network', network, '--ipc', 'private', '--cgroupns', 'private',
        '--memory', '6g', '--memory-swap', '6g', '--cpus', '2', '--pids-limit', '1024',
        '--stop-timeout', '5', '--env', 'HOST_NETNS=' + ledger['hostNetns'],
        '--env', 'HOST_CGROUPNS=' + ledger['hostCgroupns'],
        '--env', 'FIXTURE_DEADLINE=' + str(int(ledger['created'] + ledger['budget'] - 20)),
        '--env', 'FIXTURE_STARTUP_DEADLINE=' + str(int(ledger['created'] + 180)),
        '--env', 'FIXTURE_UID=' + str(ledger['uid']), '--env', 'FIXTURE_GID=' + str(ledger['gid']),
        '--env', 'FIXTURE_OWNER=' + ledger['owner'], '--env', 'FIXTURE_CASE=' + ledger['case'],
        '--env', 'WORKFLOWD_FIXTURE_SYSTEMD_SUITE=' + ledger.get('systemdSuite', 'probe'),
        '--env', 'WORKFLOWD_FIXTURE_LEGACY_STARTUP=' + ('1' if ledger.get('legacyStartup') else '0'),
        '--env', 'WORKFLOWD_FIXTURE_LEGACY_DEATH=' + ('1' if ledger.get('legacyDeath') else '0'),
        '--env', 'WORKFLOWD_FIXTURE_LEGACY_SUITE=' + ledger.get('legacySuite', 'lease'),
        '--env', 'WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_STAGE=' + ('1' if ledger.get('legacyControllerStage') else '0'),
        '--env', 'WORKFLOWD_FIXTURE_NATIVE_APP=' + ('1' if ledger.get('nativeApplication') and ledger.get('nativeFence') != 'only' else '0'),
        '--env', 'WORKFLOWD_FIXTURE_NATIVE_FAULT=' + ('1' if ledger.get('nativeFault') else '0'),
        '--env', 'WORKFLOWD_FIXTURE_NATIVE_FENCE=' + ledger.get('nativeFence', 'none'),
        '--env', 'WORKFLOWD_FIXTURE_NATIVE_CLIENT=' + ledger.get('nativeClient', 'claude'),
        '--mount', 'type=bind,src=' + str(runtime) + ',dst=/evidence',
        '--mount', 'type=bind,src=' + str(root / 'source') + ',dst=/source,readonly',
        *(['--mount', 'type=bind,src=' + ledger['dependencies'] + ',dst=/dependencies,readonly'] if ledger['case'] in ['systemd', 'systemd-death', 'legacy-build', 'legacy-test'] else []),
        *native_mount,
        '--mount', 'type=volume,src=' + ledger['volume'] + ',dst=' + ('/nix' if build else '/var/lib/docker'),
        '--entrypoint', '/bin/sh', image, '-c',
        'remaining=$((FIXTURE_DEADLINE - $(date +%s))); test "$remaining" -gt 0; exec timeout -s TERM -k 10 "$remaining" /bin/sh /source/probe.sh',
        timeout=90 if build else 30).stdout.decode().strip()
    assert re.fullmatch('[a-f0-9]{64}', created)
    ledger['containerId'] = created
    save(root / 'ledger.json', ledger)
    configured = json.loads(docker(root, 'container', 'inspect', created).stdout)[0]
    host = configured['HostConfig']
    assert configured['Config']['Labels'][LABEL] == ledger['owner']
    assert host['PidMode'] == '' and host['IpcMode'] == 'private' and host['CgroupnsMode'] == 'private'
    assert host['NetworkMode'] == network and host['Privileged'] is (not build)
    assert host['Memory'] == host['MemorySwap'] == 6 * 1024**3
    assert host['NanoCpus'] == 2000000000 and host['PidsLimit'] == 1024
    assert not any(mount['Source'] == str(root) for mount in configured['Mounts'])
    if time.time() > ledger['created'] + 180:
        raise RuntimeError('Owned backend startup exceeded its budget')
    docker(root, 'container', 'start', created)
    if ledger['case'] == 'systemd-death' or ledger.get('legacyDeath'):
        deadline = min(time.monotonic() + 45, time.monotonic() + ledger['created'] + 180 - time.time())
        marker = runtime / ('legacy-runner-ready' if ledger.get('legacyDeath') else 'systemd-ready')
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.25)
        if not marker.exists() or time.monotonic() >= deadline:
            raise RuntimeError('Private system manager prerequisite not reached')
        save(root / 'controller-death.json', {'containerId': created, 'signal': 'SIGKILL', 'time': time.time()})
        os.kill(os.getpid(), signal.SIGKILL)
    if ledger['case'] == 'death':
        save(root / 'controller-death.json', {'containerId': created, 'signal': 'SIGKILL', 'time': time.time()})
        os.kill(os.getpid(), signal.SIGKILL)
    waited = docker(root, 'container', 'wait', created, timeout=ledger['budget'] - 20)
    docker(root, 'container', 'logs', created, check=False)
    inspected = json.loads(docker(root, 'container', 'inspect', created).stdout)[0]
    save(root / 'container-receipt.json', {key: inspected[key] for key in ['Id', 'State', 'HostConfig', 'Mounts']})
    if waited.stdout.strip() != b'0' or inspected['State']['OOMKilled']:
        raise RuntimeError('Owned backend probe failed')
    if build:
        if not (runtime / 'build-completed').exists():
            raise RuntimeError('Image build unconfirmed')
        return
    if not (runtime / 'inner-stopped').exists():
        raise RuntimeError('Private daemon shutdown unconfirmed')
    if ledger['case'] in ['network', 'dagger-network']:
        counters = {}
        for family in ['ipv4', 'ipv6']:
            for phase in ['before', 'after']:
                values = {}
                for line in (runtime / (family + '-' + phase + '.rules')).read_text().splitlines():
                    match = re.match(r'^\[(\d+):\d+\] -A (WFD-[A-Z-]+) .*?-j DROP', line)
                    if match:
                        key = match[2] + (':tailscale0' if '-o tailscale0 ' in line else '')
                        values[key] = values.get(key, 0) + int(match[1])
                counters[family + '-' + phase] = values
            for chain in ['WFD-HOST', 'WFD-SANDBOX', 'WFD-SANDBOX:tailscale0']:
                assert counters[family + '-after'][chain] > counters[family + '-before'][chain], (family, chain)
        save(root / 'drop-counters.json', counters)
        if ledger['case'] == 'dagger-network':
            assert (runtime / 'dagger-ipv6').read_text().strip() == '1\n1\n1'
            for chain in ['WFD-SANDBOX', 'WFD-ENGINE']:
                def count(phase):
                    return sum(int(match[1]) for line in (runtime / ('dagger-' + phase + '.rules')).read_text().splitlines()
                               if (match := re.match(r'^\[(\d+):\d+\] -A ' + chain + r' .*?-j DROP', line)))
                assert count('after') > count('before'), chain
                assert count('after-http') == count('before-http'), 'http() unexpectedly hit engine CNI drops'
            for suffix in [r' -A WFD-HOST .*?-j DROP', r' -A WFD-SANDBOX .*?-o tailscale0 .*?-j DROP']:
                def host_count(phase):
                    return sum(int(match[1]) for line in (runtime / ('host-' + phase + '-http.rules')).read_text().splitlines()
                               if (match := re.match(r'^\[(\d+):\d+\]' + suffix, line)))
                assert host_count('after') > host_count('before'), 'http() did not increase host DROP counters'


PROBE = r'''#!/bin/sh
set -eu
umask 077
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
test "$(readlink /proc/self/ns/cgroup)" != "$HOST_CGROUPNS"
test ! -S /var/run/docker.sock
test ! -S /run/docker.sock
test ! -e /evidence/ledger.json
test ! -e /evidence/launcher.py
test ! -e /evidence/invocation.json
case "$FIXTURE_CASE" in legacy-build|legacy-test)
  while read -r name; do
    test "$(stat -c '%u:%g:%a' "/evidence/$name")" = "$FIXTURE_UID:$FIXTURE_GID:600"
    stat -c '%n %u:%g:%a' "/evidence/$name" >> /evidence/diagnostic-files.log
  done < /source/legacy-private-logs
  ;;
esac
readlink /proc/self/ns/net > /evidence/inner-netns
cat /proc/self/uid_map > /evidence/uid-map
cat /proc/self/gid_map > /evidence/gid-map
cat /proc/self/cgroup > /evidence/cgroup
cat /sys/fs/cgroup/cgroup.type > /evidence/cgroup-type
cat /sys/fs/cgroup/cgroup.controllers > /evidence/cgroup-controllers
cat /sys/fs/cgroup/cgroup.subtree_control > /evidence/cgroup-subtree-before
# cgroup v2 requires the private namespace root to be free of processes before
# enabling domain controllers for the inner engine (the standard DinD setup).
mkdir /sys/fs/cgroup/fixture-init
cat /sys/fs/cgroup/cgroup.procs > /evidence/outer-pids
while read -r pid; do
  echo "$pid" > /sys/fs/cgroup/fixture-init/cgroup.procs || test ! -d "/proc/$pid"
done < /evidence/outer-pids
sed 's/ / +/g; s/^/+/' /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
cat /sys/fs/cgroup/cgroup.subtree_control > /evidence/cgroup-subtree-after
mkdir -p /run/owned-engine
storage=vfs
if test "$FIXTURE_CASE" = native || test "$FIXTURE_CASE" = systemd || test "$FIXTURE_CASE" = systemd-death || test "$FIXTURE_CASE" = legacy-build || test "$FIXTURE_CASE" = legacy-test; then storage=overlay2; fi
set -- --bridge=none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = nats || test "$FIXTURE_CASE" = legacy-test; then
  # Only this already-verified, network-none outer namespace gets a private bridge.
  set -- --bip=172.29.0.1/24 --iptables=true --ip6tables=false --ip-forward=true --ip-masq=false
fi
dockerd --config-file=/evidence/daemon.json --host=unix:///run/owned-engine/docker.sock \
  --data-root=/var/lib/docker --exec-root=/run/owned-engine/exec --pidfile=/run/owned-engine/pid \
  --storage-driver="$storage" "$@" > /evidence/daemon.log 2>&1 &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null || true; wait "$daemon" || true; chown -R "$FIXTURE_UID:$FIXTURE_GID" /evidence' EXIT HUP INT TERM
ready=0
for attempt in $(seq 1 60); do
  if docker --host unix:///run/owned-engine/docker.sock version --format '{{json .Server}}' > /evidence/inner-version.json 2>/evidence/readiness.log; then ready=1; break; fi
  kill -0 "$daemon"
  sleep 0.5
done
test "$ready" = 1
docker --host unix:///run/owned-engine/docker.sock info --format '{{.Driver}}' > /evidence/storage-driver
test "$(cat /evidence/storage-driver)" = "$storage"
if test "$FIXTURE_CASE" = death; then sleep 240; fi
export DOCKER_HOST=unix:///run/owned-engine/docker.sock
export DOCKER_CONFIG=/evidence/docker-config
if test "$FIXTURE_CASE" = systemd || test "$FIXTURE_CASE" = systemd-death; then
  systemd_status=0
  sh /source/owned-systemd.sh > /evidence/systemd.log 2>&1 || systemd_status=$?
fi
if test "$FIXTURE_CASE" = legacy-build || test "$FIXTURE_CASE" = legacy-test; then
  systemd_status=0
  sh /source/repo/scripts/evidence/legacy-outer.sh > /evidence/legacy.log 2>&1 || systemd_status=$?
fi
if test "$FIXTURE_CASE" = network || test "$FIXTURE_CASE" = dagger-network; then
  apk add --no-network /source/packages/*.apk > /evidence/packages.log 2>&1
  sh /source/native-network.sh > /evidence/network.log 2>&1
fi
if test "$FIXTURE_CASE" = native; then
  sh /source/native-owned.sh > /evidence/native.log 2>&1
fi
if test "$FIXTURE_CASE" = dagger; then
  sh /source/owned-dagger.sh > /evidence/dagger.log 2>&1
fi
if test "$FIXTURE_CASE" = container; then
  export DOCKER_HOST=unix:///run/owned-engine/docker.sock
  export DOCKER_CONFIG=/evidence/docker-config
  docker image load --input /evidence/input-image.tar > /evidence/load.log 2>&1
  image=sha256:9a5d43f7d02971b15763b4b88d0e44cfaa858ec8a04b2fd84057b03c6f0e0f96
  docker image inspect "$image" > /evidence/inner-image.json
  inner=$(docker container create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
    --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only \
    --network none --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 \
    --tmpfs /tmp:rw,nosuid,nodev,size=16m --tmpfs /var/lib/docker:rw,nosuid,nodev,size=1m \
    --entrypoint /bin/sh "$image" -ec '
      test "$(id -u)" = 1000
      test "$(id -g)" = 1000
      grep -Eq "^CapEff:[[:space:]]+0000000000000000$" /proc/self/status
      grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
      test ! -S /var/run/docker.sock
      test ! -S /run/owned-engine/docker.sock
      test ! -e /evidence
      touch /tmp/writable-control
      if touch /etc/forbidden-write 2>/dev/null; then exit 9; fi
      id
      grep -E "^(CapEff|NoNewPrivs):" /proc/self/status
      cat /proc/self/cgroup
      cat /sys/fs/cgroup/memory.max
      cat /sys/fs/cgroup/pids.max
    ')
  echo "$inner" > /evidence/inner-container-id
  docker container start "$inner" > /evidence/inner-start.log
  status=$(docker container wait "$inner")
  docker container logs "$inner" > /evidence/inner-container.log 2>&1
  docker container inspect "$inner" > /evidence/inner-container.json
  test "$status" = 0
  docker container rm "$inner" > /evidence/inner-removed
fi
kill -TERM "$daemon"
wait "$daemon"
touch /evidence/inner-stopped
chown -R "$FIXTURE_UID:$FIXTURE_GID" /evidence
trap - EXIT HUP INT TERM
exit "${systemd_status:-0}"
'''


def main():
    os.umask(0o077)
    if len(sys.argv) == 3:
        root = Path(sys.argv[2])
        if sys.argv[1] == '--reap':
            cleanup(root)
            return 0
        if sys.argv[1] == '--run':
            try:
                probe(root)
            except BaseException as failure:
                try:
                    cleanup(root)
                except Exception as cleanup_error:
                    raise failure from cleanup_error
                raise
            else:
                cleanup(root)
                return 0
        raise ValueError('Unknown owned fixture operation')
    if sys.argv[1:] not in [[], ['--container'], ['--network'], ['--image'], ['--death'], ['--native'], ['--dagger'], ['--dagger-network'], ['--systemd'], ['--systemd-death'], ['--legacy-build'], ['--legacy-test']]: raise ValueError('Owned fixture invocation refused')
    case = sys.argv[1][2:] if sys.argv[1:] else 'startup'
    budget = 1200 if case in ['image', 'legacy-build'] else 60 if case == 'death' else 180 if case in ['startup', 'systemd-death'] else 300
    legacy_death = case == 'legacy-test' and os.environ.get('WORKFLOWD_FIXTURE_LEGACY_DEATH') == '1'
    if case == 'legacy-test' and os.environ.get('WORKFLOWD_FIXTURE_LEGACY_STARTUP') == '1': budget = 180
    root = Path(tempfile.mkdtemp(prefix='wfd-owned-docker-', dir='/tmp/opencode'))
    runtime = root / 'runtime'
    runtime.mkdir(mode=0o700)
    if case in ['legacy-build', 'legacy-test']:
        prepare_legacy_logs(runtime)
    (root / 'docker-config').mkdir(mode=0o700)
    (root / 'docker-config/config.json').write_text('{"auths":{}}')
    (runtime / 'docker-config').mkdir(mode=0o700)
    (runtime / 'docker-config/config.json').write_text('{"auths":{}}')
    (runtime / 'daemon.json').write_text('{"features":{"containerd-snapshotter":false}}')
    source = root / 'source'
    source.mkdir()
    if case in ['legacy-build', 'legacy-test']:
        (source / 'legacy-private-logs').write_text('\n'.join(LEGACY_LOGS) + '\n')
        (source / 'legacy-private-logs').chmod(0o444)
    (source / 'probe.sh').write_text(PROBE)
    (source / 'packages').mkdir()
    repo = Path(__file__).resolve().parents[2]
    for path in ['deploy/sandbox/network.sh', 'deploy/sandbox/engine.toml', 'test/sandbox/fixtures/native-network.sh', 'test/sandbox/fixtures/native-network.py', 'scripts/evidence/owned-network-inputs.json', 'test/sandbox/fixtures/native-owned.sh', 'test/sandbox/fixtures/native-owned.mjs', 'test/sandbox/fixtures/native-provider.mjs', 'test/sandbox/fixtures/owned-dagger.sh', 'test/sandbox/fixtures/owned-dagger.py', 'test/sandbox/fixtures/owned-dagger-network.py']:
        target = source / Path(path).name
        target.write_bytes((repo / path).read_bytes())
        target.chmod(0o444)
    (source / 'native_network.py').write_bytes((source / 'native-network.py').read_bytes())
    (source / 'native_network.py').chmod(0o444)
    (source / 'dagger').touch()
    source.chmod(0o555)
    inputs = {}
    if case in ['systemd', 'systemd-death', 'legacy-build', 'legacy-test']:
        source.chmod(0o755)
        shutil.copyfile(repo / 'scripts/evidence/owned-systemd.sh', source / 'owned-systemd.sh')
        paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=repo, timeout=10).decode().strip('\0').split('\0')
        hashes = {}
        for name in sorted(set(paths)):
            original = repo / name
            if not original.is_file(): continue
            assert original.resolve().is_relative_to(repo)
            target = source / 'repo' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            target.chmod(original.stat().st_mode & 0o777)
            hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
        # PrivateUsers cannot use parent-namespace DAC override to traverse the
        # copied source. This tree is mounted read-only; evidence stays owner-only.
        for directory, _, _ in os.walk(source / 'repo'):
            Path(directory).chmod(0o755)
        save(root / 'source-hashes.json', hashes)
        save(source / 'input-hashes.json', hashes)
        (source / 'bin').mkdir(mode=0o755)
        (source / 'bin').chmod(0o755)
        for name, expected in [('bun', '9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74'), ('node', '5796fd9700e83170bc7ddfdf7f18858c794a9f91cb39dd6f9e95060b292f2563')]:
            binary = Path(os.environ['WORKFLOWD_FIXTURE_' + name.upper()]).resolve(strict=True)
            assert hashlib.sha256(binary.read_bytes()).hexdigest() == expected
            shutil.copyfile(binary, source / 'bin' / name)
            (source / 'bin' / name).chmod(0o555)
        inputs = {'dependencies': str((repo / 'node_modules').resolve(strict=True)), 'systemdImage': SYSTEMD}
        inputs['systemdSuite'] = os.environ.get('WORKFLOWD_FIXTURE_SYSTEMD_SUITE', 'probe')
        assert inputs['systemdSuite'] in ['probe', 'manager', 'nats', 'resources', 'prerequisites', 'gid', 'legacy-inputs']
        assert case != 'systemd-death' or inputs['systemdSuite'] in ['probe', 'gid']
        if case in ['legacy-build', 'legacy-test']:
            inputs['legacyControllerStage'] = case == 'legacy-build' and os.environ.get('WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_STAGE') == '1'
            # Fixed accepted public inputs, copied read-only outside writable evidence.
            accepted = Path('/tmp/opencode/quality-lease-gid-dwg6nmhm')
            assert hashlib.sha256((accepted / 'SHA256SUMS').read_bytes()).hexdigest() == '74629a463df702bb569c5b103d822d2fbe122f7118c91b059bf356763b9ea23d'
            sealed = {name: digest for digest, name in (line.split('  ', 1) for line in (accepted / 'SHA256SUMS').read_text().splitlines())}
            legacy = source / 'legacy'
            legacy.mkdir()
            for original in (accepted / 'public-inputs/apt-inputs').rglob('*'):
                if not original.is_file(): continue
                assert hashlib.sha256(original.read_bytes()).hexdigest() == sealed[str(original.relative_to(accepted))]
                target = legacy / 'apt-inputs' / original.relative_to(accepted / 'public-inputs/apt-inputs')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, target)
            original = accepted / 'public-inputs/container-use-v0.4.2.tar.gz'
            assert hashlib.sha256(original.read_bytes()).hexdigest() == '3fa52b5833ae4aed2be4b86f7cf42671fdf4bca8c211fe5fff08cc19553d409b'
            shutil.copyfile(original, legacy / 'container-use.tar.gz')
            previous = Path('/tmp/opencode/wfd-owned-docker-wxkt7w7v/runtime')
            archive_hashes = {'ubuntu': '9453dacc114eacf3a3c2ad10a68bb79082cdb2da024ae71256a92dd43ccd3544', 'dagger': '07c3887cbe04fe4c32f458391fc5ebd0c1d8911c8f72106d788497e120022256'}
            for name, digest in archive_hashes.items():
                metadata = accepted / 'evidence/wfd-owned-docker-wxkt7w7v/runtime' / ('legacy-' + name + '.json')
                assert hashlib.sha256(metadata.read_bytes()).hexdigest() == sealed[str(metadata.relative_to(accepted))]
                shutil.copyfile(metadata, legacy / (name + '.json'))
                shutil.copyfile(previous / ('legacy-' + name + '.tar'), legacy / (name + '.tar'))
                with (legacy / (name + '.tar')).open('rb') as archive:
                    assert hashlib.file_digest(archive, 'sha256').hexdigest() == digest
            save(root / 'legacy-inputs.json', {'acceptedPackage': str(accepted), 'acceptedSealSha256': hashlib.sha256((accepted / 'SHA256SUMS').read_bytes()).hexdigest(), 'archiveSha256': archive_hashes, 'publicInputs': {name: digest for name, digest in sealed.items() if name.startswith('public-inputs/')}})
            extra = Path(os.environ['WORKFLOWD_FIXTURE_LEGACY_EXTRA_INPUTS']).resolve(strict=True)
            assert re.fullmatch(r'/tmp/opencode/quality-lease-[a-z0-9_]+/public-inputs', str(extra))
            for package in json.loads((repo / 'scripts/evidence/legacy-controller-inputs.json').read_text()):
                assert package['file'].startswith('pool/main/') and '..' not in Path(package['file']).parts
                data = (extra / package['file']).read_bytes()
                assert len(data) == package['bytes'] and hashlib.sha256(data).hexdigest() == package['sha256']
                target = legacy / 'apt-inputs' / package['file']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            (source / 'repo/node_modules').mkdir()
            (source / 'repo/.scratch').mkdir(exist_ok=True)
            if case == 'legacy-test':
                controller = os.environ.get('WORKFLOWD_FIXTURE_LEGACY_CONTROLLER')
                if controller:
                    controller = Path(controller).resolve(strict=True)
                    assert re.fullmatch(r'/tmp/opencode/wfd-owned-docker-[a-z0-9_]+/runtime', str(controller))
                    manifest_sha = os.environ['WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_MANIFEST_SHA256']
                    archive_sha = os.environ['WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_ARCHIVE_SHA256']
                    assert re.fullmatch('[a-f0-9]{64}', manifest_sha) and re.fullmatch('[a-f0-9]{64}', archive_sha)
                    data = (controller / 'controller-fixture.json').read_bytes()
                    assert hashlib.sha256(data).hexdigest() == manifest_sha
                    manifest = json.loads(data)
                    assert manifest['baseReference'] == SYSTEMD
                    assert re.fullmatch('sha256:[a-f0-9]{64}', manifest['image']['Id'])
                    for name, digest in manifest['sources'].items():
                        assert (repo / name).resolve().is_relative_to(repo)
                        assert hashlib.sha256((repo / name).read_bytes()).hexdigest() == digest
                    archive = controller / 'controller-built.tar'
                    assert archive.stat().st_size <= 1024**3
                    shutil.copyfile(archive, legacy / 'controller.tar')
                    with (legacy / 'controller.tar').open('rb') as stream:
                        assert hashlib.file_digest(stream, 'sha256').hexdigest() == archive_sha
                    (legacy / 'controller.json').write_bytes(data)
                    (legacy / 'controller-id').write_text(manifest['image']['Id'])
                    inputs['legacyController'] = {'directory': str(controller), 'manifestSha256': manifest_sha, 'archiveSha256': archive_sha, 'imageId': manifest['image']['Id']}
                built = Path(os.environ['WORKFLOWD_FIXTURE_LEGACY_BUILD']).resolve(strict=True)
                assert re.fullmatch(r'/tmp/opencode/wfd-owned-docker-[a-z0-9_]+/runtime', str(built))
                record_sha = os.environ['WORKFLOWD_FIXTURE_LEGACY_RECORD_SHA256']
                archive_sha = os.environ['WORKFLOWD_FIXTURE_LEGACY_ARCHIVE_SHA256']
                assert re.fullmatch('[a-f0-9]{64}', record_sha) and re.fullmatch('[a-f0-9]{64}', archive_sha)
                assert hashlib.sha256((built / 'legacy-fixture.json').read_bytes()).hexdigest() == record_sha
                record = json.loads((built / 'legacy-fixture.json').read_text())
                for name, digest in record['sources'].items():
                    assert (repo / name).resolve().is_relative_to(repo)
                    assert hashlib.sha256((repo / name).read_bytes()).hexdigest() == digest
                assert (built / 'legacy-built.tar').stat().st_size <= 2 * 1024**3
                shutil.copyfile(built / 'legacy-built.tar', legacy / 'built.tar')
                with (legacy / 'built.tar').open('rb') as archive:
                    assert hashlib.file_digest(archive, 'sha256').hexdigest() == archive_sha
                shutil.copyfile(built / 'legacy-fixture.json', legacy / 'fixture.json')
                (legacy / 'fixture.sha256').write_text(record_sha)
                inputs['legacyBuild'] = {'directory': str(built), 'recordSha256': record_sha, 'archiveSha256': archive_sha}
                inputs['legacyStartup'] = os.environ.get('WORKFLOWD_FIXTURE_LEGACY_STARTUP') == '1'
                inputs['legacyDeath'] = legacy_death
                assert not legacy_death or inputs['legacyStartup']
                suite = os.environ.get('WORKFLOWD_FIXTURE_LEGACY_SUITE', 'lease')
                assert suite in ['lease', 'transport', 'runner-init', 'engine-host-boundary', 'audit', 'bridge-cancellation', 'observation', 'skill-discovery', 'permissions']
                inputs['legacySuite'] = suite
                if suite in ['audit', 'bridge-cancellation', 'observation', 'skill-discovery', 'permissions']:
                    binary = Path(os.environ['WORKFLOWD_FIXTURE_OPENCODE2']).resolve(strict=True)
                    expected = '5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c'
                    assert hashlib.sha256(binary.read_bytes()).hexdigest() == expected
                    shutil.copyfile(binary, source / 'bin/opencode2')
                    (source / 'bin/opencode2').chmod(0o555)
                    inputs['legacyOpenCode'] = {'sha256': expected, 'version': '0.0.0-beta-19242'}
                if suite != 'lease':
                    public = Path(os.environ['WORKFLOWD_FIXTURE_LEGACY_RUNTIME_INPUTS']).resolve(strict=True)
                    assert re.fullmatch(r'/tmp/opencode/quality-transport-runtime-[a-z0-9_]+/public-inputs', str(public))
                    runtime_inputs = source / 'legacy-runtime'
                    runtime_inputs.mkdir(mode=0o755)
                    (runtime_inputs / 'ubuntu').mkdir(mode=0o755)
                    required = {
                        '534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55': 6688,
                        'f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b': 424,
                        '69f919497cada9a8611f3de61df902d9f94bf20f84552ef5bd93125c38608ef9': 2052,
                        'a60ef8ec184edb5ed91f5983f00261359fb2fe20f603e8d488b9477d32fcad70': 29764422,
                    }
                    for digest, size in required.items():
                        data = (public / 'ubuntu-oci' / digest).read_bytes()
                        assert len(data) == size and hashlib.sha256(data).hexdigest() == digest
                        target = runtime_inputs / 'ubuntu' / digest
                        target.write_bytes(data)
                        target.chmod(0o444)
                    binary = (public / 'dagger').read_bytes()
                    assert hashlib.sha256(binary).hexdigest() == '4ff971589c296ae704c07b5538237f69bed7f3c1a3c2645dda043c9db6584610'
                    (runtime_inputs / 'dagger').write_bytes(binary)
                    (runtime_inputs / 'dagger').chmod(0o555)
                    config = (repo / 'deploy/sandbox/engine.toml').read_text()
                    assert config == '# Supported by the pinned Dagger engine; deny privileged nested executions.\ninsecure-entitlements = []\n'
                    config += '\n[registry."docker.io"]\n  mirrors = ["127.0.0.1:5000"]\n[registry."127.0.0.1:5000"]\n  http = true\n'
                    (runtime_inputs / 'engine.toml').write_text(config)
                    (runtime_inputs / 'engine.toml').chmod(0o444)
                    (runtime_inputs / 'ubuntu').chmod(0o555)
                    runtime_inputs.chmod(0o555)
                    inputs['legacyRuntimeInputs'] = {'ubuntuObjects': required, 'daggerSha256': hashlib.sha256(binary).hexdigest(), 'engineConfigSha256': hashlib.sha256(config.encode()).hexdigest()}
        source.chmod(0o555)
    if case == 'native':
        archive = Path(os.environ['WORKFLOWD_FIXTURE_AGENT_IMAGE']).resolve(strict=True)
        assert re.fullmatch(r'/tmp/opencode/wfd-owned-docker-[a-z0-9_]+/(?:runtime/)?agent-image.tar', str(archive))
        assert archive.stat().st_size <= 4 * 1024**3
        digest = os.environ['WORKFLOWD_FIXTURE_AGENT_IMAGE_SHA256']
        assert re.fullmatch('[a-f0-9]{64}', digest)
        build_root = archive.parent.parent if archive.parent.name == 'runtime' else archive.parent
        for adapter in ['claude-interactive.py', 'native-client.py']:
            built_adapter = build_root / 'source/build/deploy/sandbox' / adapter
            assert built_adapter.read_bytes() == (repo / 'deploy/sandbox' / adapter).read_bytes(), 'Native adapter differs from image build input'
        inputs = {'agentArchive': str(archive), 'agentArchiveSHA256': digest}
        inputs['nativeClient'] = os.environ.get('WORKFLOWD_FIXTURE_NATIVE_CLIENT', 'claude')
        assert inputs['nativeClient'] in ['claude', 'codex', 'opencode']
        source.chmod(0o755)
        (source / 'deploy').mkdir()
        shutil.copytree(repo / 'deploy/sandbox', source / 'deploy/sandbox')
        application = os.environ.get('WORKFLOWD_FIXTURE_NATIVE_APP')
        if application:
            application = Path(application).resolve(strict=True)
            assert re.fullmatch(r'/tmp/opencode/wfd-isolated-[a-z0-9_]+/native-app', str(application))
            manifest = json.loads((application / 'inputs.json').read_text())
            for path, digest in manifest.items():
                original = (repo / path).resolve(strict=True)
                assert original.is_relative_to(repo)
                assert hashlib.sha256(original.read_bytes()).hexdigest() == digest, 'Application source changed: ' + path
            for name in ['native-owned-app.mjs', 'native-owned-provider.mjs', 'inputs.json']:
                shutil.copyfile(application / name, source / name)
            shutil.copyfile(repo / 'test/sandbox/fixtures/native-owned-job.mjs', source / 'native-owned-job.mjs')
            shutil.copyfile(repo / 'test/sandbox/fixtures/native-owned-bootstrap.mjs', source / 'native-owned-bootstrap.mjs')
            shutil.copyfile(repo / 'test/sandbox/fixtures/native-owned-fence.mjs', source / 'native-owned-fence.mjs')
            noscope = Path(shutil.which('noscope')).resolve(strict=True)
            shutil.copyfile(noscope, source / 'noscope')
            (source / 'noscope').chmod(0o555)
            inputs['nativeApplication'] = {'directory': str(application), 'noscopeSHA256': hashlib.sha256(noscope.read_bytes()).hexdigest(),
                'bundleSHA256': hashlib.sha256((source / 'native-owned-app.mjs').read_bytes()).hexdigest()}
            inputs['nativeFault'] = os.environ.get('WORKFLOWD_FIXTURE_NATIVE_FAULT') == '1'
            inputs['nativeFence'] = os.environ.get('WORKFLOWD_FIXTURE_NATIVE_FENCE', 'none')
            assert inputs['nativeFence'] in ['none', 'only']
        shutil.copyfile(repo / 'test/sandbox/fixtures/native-owned-passwd', source / 'native-owned-passwd')
        shutil.copyfile(repo / 'test/sandbox/fixtures/native-owned-docker.py', source / 'native-owned-docker.py')
        (source / 'native-owned-docker.py').chmod(0o555)
        shutil.copyfile(repo / 'test/sandbox/fixtures/native-owned-tools.py', source / 'native-owned-tools.py')
        (source / 'native-owned-tools.py').chmod(0o555)
        source.chmod(0o555)
    if case == 'image':
        source.chmod(0o755)
        build = source / 'build'
        for path in ['flake.nix', 'flake.lock', 'nix', 'deploy/sandbox/skills', 'deploy/sandbox/claude-interactive.py', 'deploy/sandbox/native-client.py', 'scripts/check-sandbox-skills.py']:
            target = build / path
            target.parent.mkdir(parents=True, exist_ok=True)
            if (repo / path).is_dir():
                shutil.copytree(repo / path, target)
            else:
                shutil.copyfile(repo / path, target)
        (source / 'probe.sh').write_bytes((repo / 'scripts/evidence/owned-image-build.sh').read_bytes())
        source.chmod(0o555)
    owner = uuid.uuid4().hex
    name = 'wfd-fixture-' + owner
    unit = 'wfd-docker-' + owner[:12]
    save(root / 'ledger.json', {'owner': owner, 'name': name, 'volume': name + '-data',
        'unit': unit, 'created': time.time(), 'imageInput': NIX if case == 'image' else IMAGE, 'hostNetns': os.readlink('/proc/self/ns/net'),
        'hostCgroupns': os.readlink('/proc/self/ns/cgroup'),
        'uid': os.getuid(), 'gid': os.getgid(), 'case': case, 'budget': budget, 'runtime': str(runtime),
        **inputs,
        'authorization': '01a18c21-cd00-7ed6-878b-d99f2586f538', 'endpoint': ENDPOINT})
    # Keep the reaper's reviewed code stable even if repository work continues.
    script = root / 'launcher.py'
    script.write_bytes(Path(__file__).read_bytes())
    reaper = ['systemd-run', '--user', '--quiet', '--unit=' + unit + '-cleanup', '--on-active=' + str(budget - 10) + 's',
        *LIMITS, '-p', 'RuntimeMaxSec=45s', '/usr/bin/python3', str(script), '--reap', str(root)]
    subprocess.run(reaper, check=True)
    command = ['systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + unit,
        *LIMITS, '-p', 'RuntimeMaxSec=' + str(budget) + 's', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
        '/usr/bin/python3', str(script), '--run', str(root)]
    save(root / 'invocation.json', {'command': command, 'independentReaper': reaper})
    result = subprocess.run(command, capture_output=True, timeout=budget + 20)
    (root / 'launcher.stdout').write_bytes(result.stdout)
    (root / 'launcher.stderr').write_bytes(result.stderr)
    save(root / 'exit.json', {'exit': result.returncode})
    if case in ['death', 'systemd-death'] or legacy_death:
        assert result.returncode != 0 and (root / 'controller-death.json').exists()
        deadline = time.monotonic() + budget + 10
        while not list(root.glob('cleanup-*.json')) and time.monotonic() < deadline:
            time.sleep(0.25)
        receipts = [json.loads(path.read_text()) for path in root.glob('cleanup-*.json')]
        assert receipts and all(value['confirmed'] for value in receipts), 'Independent cleanup unconfirmed'
        assert any(value['containersRemoved'] for value in receipts), 'Reaper did not recover owned container'
        save(root / 'death-test.json', {'controllerExit': result.returncode, 'independentCleanup': True})
        result.returncode = 0
    # A controller without a confirmed cleanup leaves the independent timer armed.
    if case not in ['death', 'systemd-death'] and not legacy_death and result.returncode == 0 and any(json.loads(path.read_text()).get('confirmed') is True for path in root.glob('cleanup-*.json')):
        subprocess.run(['systemctl', '--user', 'stop', unit + '-cleanup.timer'], check=True)
    print(json.dumps({'evidence': str(root), 'unit': unit, 'exit': result.returncode}))
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
