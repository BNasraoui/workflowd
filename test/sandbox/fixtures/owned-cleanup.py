"""Exercise concurrent exact-owner reapers with an engine boundary, never Docker."""
import importlib.util
import json
import multiprocessing
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('owned', 'scripts/evidence/owned-docker.py')
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)


def race(locked):
    with tempfile.TemporaryDirectory(prefix='cleanup-race-') as directory:
        root = Path(directory)
        owner, identifier = 'a' * 32, 'b' * 64
        (root / 'ledger.json').write_text(json.dumps({'owner': owner, 'volume': 'owned-volume', 'name': 'owned'}))
        state = root / 'present'
        state.touch()
        ready = multiprocessing.Barrier(2)

        def docker(root, *args, **kwargs):
            assert args[0] in ['container', 'network', 'volume']
            if args[1] == 'ls':
                assert args[-1] == 'label=' + owned.LABEL + '=' + owner
                value = identifier if args[0] == 'container' and state.exists() else ''
                time.sleep(.05)
            else:
                assert args[-1] == identifier
                assert state.exists(), 'racing removal attempted after absence'
                if args[1] == 'inspect':
                    value = json.dumps({'name': '/owned', 'labels': {owned.LABEL: owner}} if 'Labels' in args[3] else {'Running': False})
                elif args[1] in ['stop', 'wait']:
                    value = ''
                else:
                    assert args[1] == 'rm'
                    state.unlink()
                    value = ''
            return SimpleNamespace(stdout=value.encode())

        def worker(number):
            owned.docker = docker
            ready.wait(timeout=5)
            try:
                owned.cleanup(root) if locked else owned.cleanup_locked(root, time.monotonic() + 45)
                result = 'confirmed'
            except (AssertionError, FileNotFoundError):
                result = 'race'
            (root / str(number)).write_text(result)

        children = [multiprocessing.Process(target=worker, args=(number,)) for number in range(2)]
        for child in children:
            child.start()
        try:
            for child in children:
                child.join(timeout=10)
                assert child.exitcode == 0
        finally:
            for child in children:
                if child.is_alive():
                    child.kill()
                child.join(timeout=1)
        outcomes = sorted((root / str(number)).read_text() for number in range(2))
        assert outcomes == (['confirmed', 'confirmed'] if locked else ['confirmed', 'race'])
        assert not state.exists()
        assert len(list(root.glob('cleanup-*.json'))) == (2 if locked else 1)


race(False)  # Mutation control reproduces the old overlapping-removal failure.
race(True)
print('exact-owner concurrent cleanup verified')
