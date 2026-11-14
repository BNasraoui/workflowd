"""Actual fresh-root initialization; private diagnostic inodes survive writer death."""
import ast
import importlib.util
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


class Diagnostics(unittest.TestCase):
    def test_private_logs_survive_killed_writer_and_refuse_overwrite(self):
        spec = importlib.util.spec_from_file_location('owned', 'scripts/evidence/owned-docker.py')
        owned = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owned)
        tree = ast.parse(Path('scripts/evidence/owned-docker.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        assignments = {n.targets[0].id: i for i, n in enumerate(main.body)
                       if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}
        initialization = ast.Module(body=main.body[assignments['root']:assignments['repo']],
                                    type_ignores=[])
        with tempfile.TemporaryDirectory(prefix='owned-diagnostics-') as directory:
            parent = Path(directory)
            namespace = {**vars(owned), 'case': 'legacy-test',
                         'tempfile': SimpleNamespace(mkdtemp=lambda **_: tempfile.mkdtemp(dir=parent))}
            exec(compile(initialization, 'actual-owned-initialization', 'exec'), namespace)
            root, runtime = namespace['root'], namespace['runtime']
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
            logs = [runtime / name for name in ['daemon.log', 'legacy-phases.log']]
            identities = []
            for path in logs:
                self.assertTrue(path.is_file(), 'Diagnostic log must exist before any mount or writer')
                state = path.stat()
                identities.append((state.st_ino, state.st_uid, state.st_gid, state.st_mode & 0o777))
                self.assertEqual(identities[-1][1:], (os.getuid(), os.getgid(), 0o600))
                self.assertEqual(path.read_bytes(), b'')
            child = subprocess.Popen(['/bin/sh', '-c',
                'printf "diagnostic canary\\n" > "$1/daemon.log"; '
                'printf "1.00 controller-load start\\n" > "$1/legacy-phases.log"; '
                'printf ready; exec sleep 30', 'owned-writer', str(runtime)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                self.assertTrue(select.select([child.stdout], [], [], 3)[0])
                self.assertEqual(child.stdout.read(5), b'ready')
                os.killpg(child.pid, signal.SIGKILL)
                output, error = child.communicate(timeout=3)
                self.assertEqual((child.returncode, output, error), (-signal.SIGKILL, b'', b''))
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.communicate(timeout=3)
            for path, before in zip(logs, identities, strict=True):
                state = path.stat()
                self.assertEqual((state.st_ino, state.st_uid, state.st_gid, state.st_mode & 0o777), before)
            self.assertEqual(logs[0].read_bytes(), b'diagnostic canary\n')
            self.assertEqual(logs[1].read_bytes(), b'1.00 controller-load start\n')
            with self.assertRaises(FileExistsError):
                owned.prepare_legacy_logs(runtime)
            self.assertEqual(logs[0].read_bytes(), b'diagnostic canary\n')
            other = parent / 'unexpected-link'
            other.mkdir(mode=0o700)
            (other / 'daemon.log').symlink_to(logs[0])
            with self.assertRaises(FileExistsError):
                owned.prepare_legacy_logs(other)
            self.assertTrue((other / 'daemon.log').is_symlink())
            self.assertEqual(logs[0].read_bytes(), b'diagnostic canary\n')


if __name__ == '__main__':
    unittest.main()
