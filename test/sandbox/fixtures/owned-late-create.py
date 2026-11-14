"""Exercise actual launcher recovery with synthetic command responses, never Docker."""
import ast
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


class Cleanup(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('owned', 'scripts/evidence/owned-docker.py')
        self.owned = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.owned)
        self.temporary = tempfile.TemporaryDirectory(prefix='owned-cleanup-')
        self.root = Path(self.temporary.name)
        (self.root / 'runtime').mkdir()
        self.owner, self.identifier = 'a' * 32, 'b' * 64
        self.name = 'wfd-fixture-' + self.owner
        self.ledger = dict(case='startup', created=1000, owner=self.owner, name=self.name,
                           volume=self.name + '-data', unit='wfd-docker-' + self.owner[:12],
                           hostNetns='fixture-net', hostCgroupns='fixture-cgroup',
                           budget=180, uid=1000, gid=1000)
        self.owned.save(self.root / 'ledger.json', self.ledger)
        self.owned.save(self.root / 'invocation.json', {
            'syntheticControl': True,
            'independentReaper': ['systemd-run', '--on-active=170s', '--reap', str(self.root)],
        })
        self.custody = {name: (self.root / name).read_bytes()
                        for name in ['ledger.json', 'invocation.json']}
        self.clock = 0.0
        self.cleanup_start = None
        self.mode = 'late'
        self.calls = []
        self.listings = 0
        self.network_listings = 0
        self.attached = False
        self.removed = False
        self.volume = True
        self.holder = None
        self.lock_wait = None
        self.budget_check = False
        self.expire_at_final_inventory = False
        self.failure = None
        self.owned.time = SimpleNamespace(monotonic=lambda: self.clock,
                                         time=lambda: 1000 + self.clock, sleep=self.sleep)
        self.owned.subprocess = SimpleNamespace(run=self.command,
                                               TimeoutExpired=subprocess.TimeoutExpired)
        self.owned.sys = SimpleNamespace(argv=['owned', '--run', str(self.root)])

    def tearDown(self):
        if self.holder is not None:
            self.holder.close()
        self.owned.save(self.root / 'synthetic-boundary.json', {
            'qualification': 'Synthetic command/clock boundary; real launcher, receipts and flock.',
            'calls': self.calls,
            'clock': self.clock,
        })
        evidence = os.environ.get('OWNED_CLEANUP_EVIDENCE')
        if evidence:
            shutil.copytree(self.root, Path(evidence) / self._testMethodName)
        self.temporary.cleanup()

    def sleep(self, _seconds):
        self.clock += self.lock_wait
        if self.lock_wait < 25:
            self.holder.close()
            self.holder = None

    def command(self, command, *, env, capture_output, timeout):
        self.assertEqual(command[:5], ['/usr/bin/docker', '--host', self.owned.ENDPOINT,
                                      '--config', str(self.root / 'docker-config')])
        self.assertEqual(env, {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})
        self.assertTrue(capture_output)
        args = tuple(command[5:])
        self.calls.append({'args': args, 'timeout': timeout, 'at': self.clock})
        if self.cleanup_start is not None:
            # A distinct open description must be excluded by the real shared lock.
            with (self.root / 'cleanup.lock').open('a') as other:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(list(self.root.glob('cleanup-*.json')))
            if self.budget_check:
                maximum = 10 if args[:2] in [('container', 'stop'), ('container', 'wait'),
                                             ('container', 'rm'), ('volume', 'rm')] else 30
                self.assertGreater(timeout, 0)
                self.assertLessEqual(timeout, min(maximum, self.cleanup_start + 45 - self.clock))
        self.clock += .1
        value, error, code = '', b'', 0
        selector = 'label=' + self.owned.LABEL + '=' + self.owner
        if args[:2] in [('image', 'pull'), ('volume', 'create')]:
            self.assertIsNone(self.cleanup_start)
        elif args[:2] == ('container', 'create'):
            self.assertEqual(timeout, 30)
            self.clock += 30
            self.cleanup_start = self.clock
            self.failure = subprocess.TimeoutExpired(command, timeout,
                                                     output=b'partial create output\n',
                                                     stderr=b'partial create diagnostic\n')
            raise self.failure
        elif args[:2] == ('container', 'ls'):
            self.assertEqual(args[-2:], ('--filter', selector))
            self.listings += 1
            value = self.identifier if self.attached and not self.removed else ''
        elif args[:2] == ('container', 'inspect'):
            self.assertEqual(args[-1], self.identifier)
            if args[3] == '{{json .State}}':
                self.assertEqual(self.calls[-2]['args'][:2], ('container', 'wait'))
                value = json.dumps({'Running': False, 'Pid': 0, 'Status': 'created'})
            else:
                value = json.dumps({'name': '/' + (self.name if self.mode != 'wrong-name' else 'foreign'),
                                    'labels': {self.owned.LABEL: 'c' * 32 if self.mode == 'foreign' else self.owner}})
        elif args[:2] in [('container', 'stop'), ('container', 'wait'), ('container', 'rm')]:
            self.assertEqual(args[-1], self.identifier)
            self.assertNotIn(self.mode, ['foreign', 'wrong-name', 'wrong-id'])
            if args[1] == 'wait':
                self.assertEqual(self.calls[-2]['args'][:2], ('container', 'stop'))
            if args[1] == 'rm':
                state = json.loads((self.root / ('stopped-' + self.identifier + '.json')).read_text())
                self.assertFalse(state['Running'])
                self.removed = True
        elif args[:2] == ('volume', 'ls'):
            self.assertEqual(args[-2:], ('--filter', selector))
            value = self.ledger['volume'] if self.volume else ''
        elif args[:2] == ('volume', 'inspect'):
            self.assertEqual(args[-1], self.ledger['volume'])
            value = json.dumps({self.owned.LABEL: self.owner})
        elif args[:2] == ('volume', 'rm'):
            self.assertEqual(args[-1], self.ledger['volume'])
            if not self.removed:
                self.attached = self.mode != 'unresolved'
                code = 1
                # This ID deliberately differs from the fresh inventory: never authority.
                error = (f"Error response from daemon: remove {self.ledger['volume']}: "
                         f"volume is in use - [{'f' * 64}]\n").encode()
                if self.mode == 'unrelated':
                    error = b'Error response from daemon: permission denied\n'
            else:
                self.volume = False
        elif args[:2] == ('network', 'ls'):
            self.assertEqual(args[-2:], ('--filter', selector))
            self.network_listings += 1
            if self.expire_at_final_inventory and self.network_listings == 2:
                self.clock = self.cleanup_start + 45
        else:
            self.fail('Unexpected executable or Docker operation: ' + repr(command))
        return subprocess.CompletedProcess(command, code, value.encode(), error)

    def retained(self):
        for name, data in self.custody.items():
            self.assertEqual((self.root / name).read_bytes(), data)
        self.assertFalse(any(c['args'][:2] == ('container', 'start') for c in self.calls))
        # Execute the actual parent's disarm guard with its failed child result.
        tree = ast.parse(Path('scripts/evidence/owned-docker.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        guard = [n for n in main.body if isinstance(n, ast.If)][-1]
        exec(compile(ast.Module(body=[guard], type_ignores=[]), 'owned-disarm-guard', 'exec'),
             {**vars(self.owned), 'root': self.root, 'case': 'legacy-test', 'legacy_death': False,
              'result': SimpleNamespace(returncode=1), 'unit': self.ledger['unit']})

    def test_late_create_recovers_and_preserves_original_failure(self):
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            self.owned.main()
        self.assertIs(raised.exception, self.failure)
        self.retained()
        receipts = [json.loads(p.read_text()) for p in self.root.glob('cleanup-*.json')]
        self.assertEqual(receipts, [{'owner': self.owner, 'containersRemoved': [self.identifier],
                                    'volumesRemoved': [self.ledger['volume']],
                                    'networksRemoved': [], 'confirmed': True}])
        self.assertTrue(self.removed)
        self.assertFalse(self.volume)
        records = [json.loads(p.read_text()) for p in self.root.glob('command-*.json')]
        failed = [r for r in records if r.get('exit') == 1]
        self.assertEqual(len(failed), 1)
        self.assertEqual(sum(c['args'][:2] == ('volume', 'rm') for c in self.calls), 2)
        for record in records:
            self.assertLessEqual(record['started'], record['finished'])
            self.assertGreaterEqual(record['elapsed'], 0)
        timed = next(p for p in self.root.glob('command-*.json') if 'timeout' in json.loads(p.read_text()))
        self.assertEqual(timed.with_suffix('.stdout').read_bytes(), b'partial create output\n')
        self.assertEqual(timed.with_suffix('.stderr').read_bytes(), b'partial create diagnostic\n')

    def refusal(self, mode):
        self.mode = mode
        if mode == 'wrong-id':
            self.ledger['containerId'] = 'd' * 64
            self.owned.save(self.root / 'ledger.json', self.ledger)
            self.custody['ledger.json'] = (self.root / 'ledger.json').read_bytes()
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            self.owned.main()
        self.assertIs(raised.exception, self.failure)
        self.assertIsNotNone(raised.exception.__cause__)
        self.retained()
        self.assertFalse(list(self.root.glob('cleanup-*.json')))
        self.assertFalse(self.removed)
        self.assertTrue(self.volume)
        removals = [c for c in self.calls if c['args'][:2] == ('volume', 'rm')]
        self.assertEqual(len(removals), 2 if mode == 'unresolved' else 1)
        if mode in ['foreign', 'wrong-name', 'wrong-id']:
            self.assertGreaterEqual(self.listings, 2)

    def test_foreign_label_is_not_deleted(self):
        self.refusal('foreign')

    def test_mismatched_identity_is_not_deleted(self):
        self.refusal('wrong-name')

    def test_saved_container_identity_is_not_replaced(self):
        self.refusal('wrong-id')

    def test_unresolved_race_retains_custody(self):
        self.refusal('unresolved')

    def test_unrelated_error_is_not_retried(self):
        self.refusal('unrelated')
        self.assertEqual(self.listings, 1)

    def test_lock_wait_and_commands_share_one_budget(self):
        self.holder = (self.root / 'cleanup.lock').open('a')
        fcntl.flock(self.holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock_wait, self.budget_check = 20, True
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            self.owned.main()
        self.assertIs(raised.exception, self.failure)
        self.assertTrue(list(self.root.glob('cleanup-*.json')))
        self.assertLess(self.clock - self.cleanup_start, 45)
        self.retained()

    def test_final_deadline_refuses_confirmation(self):
        self.cleanup_start, self.volume, self.expire_at_final_inventory = 0, False, True
        with self.assertRaisesRegex(RuntimeError, 'budget'):
            self.owned.cleanup(self.root)
        self.assertFalse(list(self.root.glob('cleanup-*.json')))
        self.retained()

    def test_lock_deadline_retains_custody(self):
        self.holder = (self.root / 'cleanup.lock').open('a')
        fcntl.flock(self.holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock_wait = 25
        with self.assertRaisesRegex(RuntimeError, 'busy'):
            self.owned.cleanup(self.root)
        self.assertEqual(self.clock, 25)
        self.assertEqual(self.calls, [])
        self.assertFalse(list(self.root.glob('cleanup-*.json')))
        self.retained()


if __name__ == '__main__':
    unittest.main()
