"""The unit of the gateway's front, a second tailscaled, read as text; nothing runs."""
from pathlib import Path
import shlex
import unittest

from test_gateway_unit import unit_entries, values

ROOT = Path(__file__).resolve().parents[2]
UNIT = ROOT / 'deploy/systemd/workflowd-gateway-front.service'
GATEWAY_UNIT = ROOT / 'deploy/systemd/workflowd-gateway.service'
NAME = 'workflowd-gateway-front'
STATE = f'/var/lib/{NAME}'
SOCKET = f'/run/{NAME}/tailscaled.sock'
# The host's own tailscaled: its state, its socket, its port and its interface.
HOST_PATHS = ('/var/lib/tailscale', '/var/run/tailscale', '/run/tailscale')


class GatewayFrontUnitTests(unittest.TestCase):
    def setUp(self):
        self.entries = unit_entries(UNIT)
        self.service = {k: v for (s, k, v) in self.entries if s == 'Service'}
        [start] = values(self.entries, 'Service', 'ExecStart')
        self.run = shlex.split(start)

    def flag(self, name):
        found = [word.split('=', 1)[1] for word in self.run if word.startswith(f'--{name}=')]
        self.assertEqual(len(found), 1, name)
        return found[0]

    def test_runs_tailscaled_as_its_own_system_user(self):
        self.assertEqual(self.run[0], '/usr/sbin/tailscaled')
        self.assertEqual(self.service.get('User'), NAME)
        self.assertEqual(self.service.get('Group'), NAME)
        self.assertNotIn('DynamicUser', self.service)
        self.assertNotIn('SupplementaryGroups', self.service)

    def test_uses_userspace_networking_and_needs_no_capability(self):
        self.assertEqual(self.flag('tun'), 'userspace-networking')
        self.assertEqual(self.service.get('CapabilityBoundingSet'), '')
        self.assertEqual(self.service.get('AmbientCapabilities'), '')
        self.assertEqual(self.service.get('PrivateDevices'), 'yes')

    def test_has_its_own_state_socket_and_port(self):
        self.assertEqual(self.flag('statedir'), STATE)
        self.assertEqual(self.flag('state'), f'{STATE}/tailscaled.state')
        self.assertEqual(self.flag('socket'), SOCKET)
        self.assertEqual(self.flag('port'), '0')
        self.assertEqual(self.service.get('StateDirectory'), NAME)
        self.assertEqual(self.service.get('RuntimeDirectory'), NAME)
        text = UNIT.read_text()
        for path in HOST_PATHS:
            self.assertNotIn(path, text)

    def test_closes_its_state_and_socket_to_the_front_group(self):
        # The gateway's container has the front's group: the group must not reach the LocalAPI.
        self.assertEqual(self.service.get('StateDirectoryMode'), '0700')
        self.assertEqual(self.service.get('RuntimeDirectoryMode'), '0700')
        self.assertEqual(self.service.get('UMask'), '0077')
        self.assertIn('--group-add ${WORKFLOWD_GATEWAY_FRONT_GID}', GATEWAY_UNIT.read_text())

    def test_is_hardened_as_the_gateway_unit(self):
        for key in ('NoNewPrivileges', 'ProtectHome', 'PrivateTmp', 'ProtectClock',
                    'ProtectControlGroups', 'ProtectKernelLogs', 'ProtectKernelModules',
                    'ProtectKernelTunables', 'RestrictNamespaces', 'LockPersonality'):
            self.assertEqual(self.service.get(key), 'yes', key)
        self.assertEqual(self.service.get('ProtectSystem'), 'strict')
        self.assertNotIn('ReadWritePaths', self.service)
        self.assertEqual(
            self.service.get('RestrictAddressFamilies'), 'AF_UNIX AF_INET AF_INET6 AF_NETLINK')
        self.assertEqual(values(self.entries, 'Service', 'Restart'), ['on-failure'])
        self.assertEqual(values(self.entries, 'Install', 'WantedBy'), ['multi-user.target'])


if __name__ == '__main__':
    unittest.main()
