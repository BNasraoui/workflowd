#!/usr/bin/env python3
"""Build/CI invariant: the catalog advertises exactly the immutable installed skills."""
import json
import re
from pathlib import Path
import sys
import yaml

catalog = json.load(sys.stdin)
root = Path(sys.argv[1])
assert {p.name for p in root.iterdir()} == {s['name'] for s in catalog['skills']}
for skill in catalog['skills']:
    assert re.fullmatch(r'[a-z][a-z0-9-]*', skill['name']), skill['name']
    folder = root / skill['name']
    metadata = yaml.safe_load((folder / 'SKILL.md').read_text().split('---', 2)[1])
    assert metadata['name'] == skill['name'], skill['name']
    assert metadata['description'].strip() == skill['description'].strip(), skill['name']
    assert (folder / 'LICENSE.upstream').is_file(), skill['name']
    for path in [folder, *folder.rglob('*')]:
        assert not path.is_symlink(), path
        assert path.stat().st_mode & 0o222 == 0, path
print(f"Verified {len(catalog['skills'])} immutable sandbox skills")
