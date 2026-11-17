"""The gateway's unit and its example environment file, read as text; nothing runs."""
import json
from pathlib import Path
import re
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[2]
UNIT = ROOT / 'deploy/systemd/workflowd-gateway.service'
EXAMPLE = ROOT / 'deploy/gateway.env.example'
STATE = '/var/lib/workflowd-gateway'
IMAGE = re.compile(r'^ghcr\.io/bnasraoui/workflowd-gateway@sha256:<64 hex>$')


def unit_entries(path):
    """The (section, key, value) entries of a unit file, with continuation lines joined."""
    entries = []
    section = None
    pending = ''
    for raw in path.read_text().splitlines():
        line = pending + raw.strip()
        pending = ''
        if line.endswith('\\'):
            pending = line[:-1] + ' '
            continue
        if not line or line.startswith(('#', ';')):
            continue
        if line.startswith('['):
            section = line.strip('[]')
            continue
        key, value = line.split('=', 1)
        entries.append((section, key, value))
    return entries


def values(entries, section, key):
    return [value for (s, k, value) in entries if s == section and k == key]


def flag_values(words, flag):
    return [words[i + 1] for i, word in enumerate(words) if word == flag]


def example_entries():
    """The variables of the example environment file, quotes removed as systemd removes them."""
    entries = {}
    for line in EXAMPLE.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        if value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        entries[key] = value
    return entries


def example_config():
    """The example's WORKFLOWD_CAPABILITY_GATEWAY, with each bare placeholder made a number."""
    text = example_entries()['WORKFLOWD_CAPABILITY_GATEWAY']
    return json.loads(re.sub(r'(?<!")<[a-z-]+>(?!")', '0', text))


class GatewayUnitTests(unittest.TestCase):
    def setUp(self):
        self.entries = unit_entries(UNIT)
        [start] = values(self.entries, 'Service', 'ExecStart')
        self.run = shlex.split(start)

    def test_is_a_system_unit_that_runs_the_image_as_the_image_user(self):
        self.assertEqual(values(self.entries, 'Install', 'WantedBy'), ['multi-user.target'])
        self.assertEqual(values(self.entries, 'Unit', 'Requires'), ['docker.service'])
        self.assertIn('docker.service', ' '.join(values(self.entries, 'Unit', 'After')))
        self.assertEqual(values(self.entries, 'Service', 'User'), [])
        self.assertEqual(self.run[:2], ['/usr/bin/docker', 'run'])
        # No --user and no --entrypoint: the image's uid 10001 and its own command.
        self.assertNotIn('--user', self.run)
        self.assertNotIn('--entrypoint', self.run)
        self.assertNotIn('--privileged', self.run)
        self.assertEqual(self.run[-1], '${WORKFLOWD_GATEWAY_IMAGE}')
        self.assertEqual(flag_values(self.run, '--pull'), ['never'])
        self.assertEqual(flag_values(self.run, '--name'), ['workflowd-gateway'])

    def test_reads_its_own_environment_file_and_passes_only_the_gateway_configuration(self):
        self.assertEqual(
            values(self.entries, 'Service', 'EnvironmentFile'),
            ['/etc/workflowd-gateway/gateway.env'],
        )
        self.assertEqual(flag_values(self.run, '--env'), ['WORKFLOWD_CAPABILITY_GATEWAY'])
        self.assertNotIn('--env-file', self.run)
        self.assertEqual(
            flag_values(self.run, '--group-add'),
            ['${WORKFLOWD_GATEWAY_DAEMON_GID}', '${WORKFLOWD_GATEWAY_FRONT_GID}'],
        )

    def test_container_writes_only_its_state_directory_and_a_private_tmp(self):
        self.assertIn('--read-only', self.run)
        self.assertEqual(flag_values(self.run, '--tmpfs'), ['/tmp'])
        self.assertEqual(flag_values(self.run, '--volume'), [f'{STATE}:{STATE}'])
        self.assertNotIn('--mount', self.run)
        self.assertEqual(flag_values(self.run, '--cap-drop'), ['ALL'])
        self.assertNotIn('--cap-add', self.run)
        self.assertEqual(flag_values(self.run, '--security-opt'), ['no-new-privileges'])
        self.assertEqual(flag_values(self.run, '--ulimit'), ['core=0'])

    def test_stop_gives_the_gateway_fifteen_seconds_before_a_kill(self):
        self.assertEqual(flag_values(self.run, '--stop-timeout'), ['15'])
        self.assertEqual(
            values(self.entries, 'Service', 'ExecStop'),
            ['/usr/bin/docker stop --time 15 workflowd-gateway'],
        )
        [timeout] = values(self.entries, 'Service', 'TimeoutStopSec')
        self.assertGreater(int(timeout), 15)
        # A container that an earlier start left gets the same stop, never a kill.
        pre = values(self.entries, 'Service', 'ExecStartPre')
        self.assertEqual(
            pre,
            [
                '-/usr/bin/docker stop --time 15 workflowd-gateway',
                '-/usr/bin/docker rm workflowd-gateway',
            ],
        )

    def test_restarts_as_the_other_units(self):
        self.assertEqual(values(self.entries, 'Service', 'Restart'), ['on-failure'])
        self.assertEqual(values(self.entries, 'Service', 'RestartSec'), ['5'])

    def test_docker_client_is_hardened(self):
        service = {k: v for (s, k, v) in self.entries if s == 'Service'}
        self.assertEqual(service.get('NoNewPrivileges'), 'yes')
        self.assertEqual(service.get('ProtectSystem'), 'strict')
        self.assertEqual(service.get('ProtectHome'), 'yes')
        self.assertEqual(service.get('CapabilityBoundingSet'), '')
        self.assertEqual(service.get('RestrictAddressFamilies'), 'AF_UNIX')
        self.assertNotIn('ReadWritePaths', service)


class GatewayExampleTests(unittest.TestCase):
    def test_example_names_the_unit_variables_with_placeholders_only(self):
        entries = example_entries()
        self.assertEqual(
            sorted(entries),
            [
                'WORKFLOWD_CAPABILITY_GATEWAY',
                'WORKFLOWD_GATEWAY_DAEMON_GID',
                'WORKFLOWD_GATEWAY_FRONT_GID',
                'WORKFLOWD_GATEWAY_IMAGE',
            ],
        )
        self.assertRegex(entries['WORKFLOWD_GATEWAY_IMAGE'], IMAGE)
        self.assertEqual(entries['WORKFLOWD_GATEWAY_DAEMON_GID'], '<daemon-gid>')
        self.assertEqual(entries['WORKFLOWD_GATEWAY_FRONT_GID'], '<front-gid>')

    def test_example_configuration_has_each_key_of_the_procedure(self):
        config = example_config()
        self.assertEqual(
            sorted(config),
            sorted([
                'noscope', 'storePath', 'controlSocket', 'daemon', 'login', 'providerId',
                'credentialRole', 'maxStreams', 'maxStreamsPerRun', 'gitRead', 'listen',
            ]),
        )
        self.assertEqual(sorted(config['noscope']), ['binary', 'configHome'])
        self.assertEqual(sorted(config['daemon']), ['gid', 'uid'])
        self.assertEqual(sorted(config['login']), ['directory'])
        self.assertEqual(sorted(config['listen']), ['front', 'service', 'socket'])
        self.assertEqual(sorted(config['listen']['front']), ['gid', 'uid'])
        self.assertIs(config['gitRead'], True)
        self.assertEqual(config['noscope']['binary'], '/bin/noscope')
        self.assertEqual(config['listen']['service'], '<service-name>.<tailnet-name>.ts.net')

    def test_each_path_the_gateway_writes_is_in_the_state_directory(self):
        config = example_config()
        for path in [
            config['storePath'],
            config['controlSocket'],
            config['login']['directory'],
            config['listen']['socket'],
            config['noscope']['configHome'],
        ]:
            self.assertTrue(path.startswith(f'{STATE}/'), path)
        # Each socket has a directory of its own, which the gateway makes with its group.
        sockets = [config['controlSocket'], config['listen']['socket']]
        self.assertEqual(len({str(Path(path).parent) for path in sockets}), 2)
        self.assertNotIn(str(Path(STATE)), [str(Path(path).parent) for path in sockets])


if __name__ == '__main__':
    unittest.main()
