#!/usr/bin/env python3
"""Build/CI invariant: the catalog advertises exactly the immutable installed skills."""
import json
from pathlib import Path
import sys
import yaml

catalog = json.loads(Path(sys.argv[1]).read_text())
root = Path(sys.argv[2])
assert {p.name for p in root.iterdir()} == {s['name'] for s in catalog['skills']}
for skill in catalog['skills']:
    folder = root / skill['name']
    metadata = yaml.safe_load((folder / 'SKILL.md').read_text().split('---', 2)[1])
    assert metadata['name'] == skill['name'], skill['name']
    assert metadata['description'].strip() == skill['description'].strip(), skill['name']
    assert (folder / 'LICENSE.upstream').is_file(), skill['name']
    for path in [folder, *folder.rglob('*')]:
        assert not path.is_symlink(), path
        assert path.stat().st_mode & 0o222 == 0, path
print(f"Verified {len(catalog['skills'])} immutable sandbox skills")
