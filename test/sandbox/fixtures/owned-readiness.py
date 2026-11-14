"""Drive the real probe across its readiness boundary without Docker or signals."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
from types import SimpleNamespace
import unittest


class OwnedStop(Exception):
    pass


class Readiness(unittest.TestCase):
    def admission(self, arrival, expected):
        spec = importlib.util.spec_from_file_location('owned', 'scripts/evidence/owned-docker.py')
        owned = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owned)
        with tempfile.TemporaryDirectory(prefix='owned-readiness-') as directory:
            root = Path(directory)
            runtime = root / 'runtime'
            runtime.mkdir()
            owner, identifier = 'a' * 32, 'b' * 64
            ledger = dict(case='systemd-death', created=1000, owner=owner, name='owned-test',
                          volume='owned-test-data', hostNetns='fake-net', hostCgroupns='fake-cgroup',
                          budget=180, uid=1000, gid=1000, dependencies='/fake-readonly')
            (root / 'ledger.json').write_text(json.dumps(ledger))
            clock = [0.0]
            signals = []

            def sleep(seconds):
                # A final scheduler wake can be just before, at, or after 45s.
                clock[0] = arrival if clock[0] >= 44.75 else clock[0] + seconds
                if clock[0] >= arrival:
                    (runtime / 'systemd-ready').touch()

            def stop(pid, kind):
                self.assertEqual((pid, kind), (123456, signal.SIGKILL))
                signals.append(clock[0])
                raise OwnedStop()

            def docker(_root, *args, **_kwargs):
                # Only the provisioning boundary is synthetic; probe admission is real.
                if args[:2] == ('container', 'create'):
                    value = identifier
                elif args[:2] == ('container', 'inspect'):
                    value = json.dumps([dict(Config=dict(Labels={owned.LABEL: owner}), Mounts=[],
                        HostConfig=dict(PidMode='', IpcMode='private', CgroupnsMode='private',
                            NetworkMode='none', Privileged=True, Memory=6 * 1024**3,
                            MemorySwap=6 * 1024**3, NanoCpus=2000000000, PidsLimit=1024))])
                else:
                    self.assertIn(args[:2], [('image', 'pull'), ('image', 'save'), ('image', 'inspect'),
                                             ('volume', 'create'), ('container', 'start')])
                    value = ''
                return SimpleNamespace(stdout=value.encode())

            owned.docker = docker
            owned.time = SimpleNamespace(monotonic=lambda: clock[0], time=lambda: 1000 + clock[0], sleep=sleep)
            owned.os = SimpleNamespace(getpid=lambda: 123456, kill=stop, fsync=os.fsync)
            with self.assertRaises(OwnedStop if expected else RuntimeError):
                owned.probe(root)
            self.assertEqual(signals, [arrival] if expected else [])
            self.assertEqual((root / 'controller-death.json').exists(), expected)

    def test_ready_before_deadline(self):
        self.admission(44.99, True)

    def test_ready_at_deadline(self):
        self.admission(45, False)

    def test_ready_during_late_final_sleep(self):
        self.admission(45.1, False)


if __name__ == '__main__':
    unittest.main()
