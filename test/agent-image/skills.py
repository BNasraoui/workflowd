"""Check the exported image, including ownership and readability as the agent user."""
import json
import os
from pathlib import Path

catalog = json.loads(Path('/tmp/catalog.json').read_text())
root = Path(catalog['root'])
assert os.getuid() == 1000
assert {p.name for p in root.iterdir()} == {s['name'] for s in catalog['skills']}
for skill in catalog['skills']:
    folder = root / skill['name']
    assert (folder / 'SKILL.md').read_text()
    assert (folder / 'LICENSE.upstream').read_text()
    for path in [root, folder, *folder.rglob('*')]:
        assert not os.access(path, os.W_OK), path
        assert os.access(path, os.R_OK), path
    if skill['name'] == 'visual-pr':
        for reference in ('pr_description_template.md', 'show-me.md'):
            assert (folder / 'references' / reference).read_text()
print(f"Image exposes exactly {len(catalog['skills'])} readable, read-only skills")
