"""Inspection-boundary controls; these do not stand in for actual image builds."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location('binding', 'scripts/evidence/legacy-images.py')
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)
scenario = sys.argv[1]
roots = {root: {'Id': values['id'], 'RepoDigests': [root],
                'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + 'a' * 64]}}
         for root, values in binding.ROOTS.items()}
images = {value['Id']: copy.deepcopy(value) for value in roots.values()}
calls = []
def inspect(image):
    calls.append(image)
    return images[image]

if scenario == 'unknown-root':
    roots['ubuntu:24.04'] = roots.pop(next(iter(roots)))
elif scenario == 'wrong-config':
    next(iter(roots.values()))['Id'] = 'sha256:' + 'b' * 64
elif scenario == 'wrong-layers':
    next(iter(images.values()))['RootFS']['Layers'] = ['sha256:' + 'b' * 64]

try:
    if scenario == 'corrupt-archive':
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar'
            archive.write_bytes(b'not the approved archive')
            root = next(iter(roots))
            binding.verify_archive(root, archive, roots[root])
    else:
        binding.verify_loaded(roots, inspect)
except (AssertionError, ValueError):
    assert scenario != 'matching'
else:
    assert scenario == 'matching', 'Invalid input was admitted'
if scenario in ['unknown-root', 'wrong-config', 'corrupt-archive']:
    assert calls == [], 'Invalid binding reached the engine'
elif scenario == 'matching':
    assert calls == [r['id'] for r in binding.ROOTS.values()]
print(json.dumps({'scenario': scenario, 'verified': True}))
