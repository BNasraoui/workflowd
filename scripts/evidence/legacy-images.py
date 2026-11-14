#!/usr/bin/python3
"""Fixed two-image binding for the isolated legacy fixture, never production pins."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

ROOTS = {
    'ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55': {
        'name': 'ubuntu',
        'id': 'sha256:69f919497cada9a8611f3de61df902d9f94bf20f84552ef5bd93125c38608ef9',
        'archive': '9453dacc114eacf3a3c2ad10a68bb79082cdb2da024ae71256a92dd43ccd3544',
    },
    'registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36': {
        'name': 'dagger',
        'id': 'sha256:b5ef265238e4a72ab3f7d987f089dfc5fa597882874f48f1c2cc7e9dc990d90b',
        'archive': '07c3887cbe04fe4c32f458391fc5ebd0c1d8911c8f72106d788497e120022256',
    },
}


def digest(file):
    return hashlib.file_digest(file, 'sha256').hexdigest()


def verify_archive(root, path, metadata):
    expected = ROOTS[root]
    assert metadata['Id'] == expected['id'] and root in metadata['RepoDigests']
    assert path.stat().st_size <= 1024**3
    with path.open('rb') as file:
        assert digest(file) == expected['archive'], 'Unapproved image archive'
    with tarfile.open(path) as archive:
        manifest = json.load(archive.extractfile('manifest.json'))
        assert len(manifest) == 1
        entry = manifest[0]
        config = archive.extractfile(entry['Config']).read(1048577)
        assert len(config) <= 1048576 and 'sha256:' + hashlib.sha256(config).hexdigest() == expected['id']
        layers = metadata['RootFS']['Layers']
        assert json.loads(config)['rootfs']['diff_ids'] == layers and len(entry['Layers']) == len(layers)
        for name, layer in zip(entry['Layers'], layers):
            assert archive.getmember(name).size <= 1024**3
            with archive.extractfile(name) as file:
                assert 'sha256:' + digest(file) == layer, 'Image layer differs from pulled input'


def verify_loaded(roots, inspect):
    assert set(roots) == set(ROOTS), 'Only the two approved root digests are admitted'
    for root, expected in ROOTS.items():
        assert roots[root]['Id'] == expected['id'], 'Configuration does not match approved root'
    for root, expected in ROOTS.items():
        actual = inspect(expected['id'])
        assert actual['Id'] == expected['id'] and actual['RootFS'] == roots[root]['RootFS'], 'Private image content differs'


def inspect(image):
    return json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], timeout=20))[0]


def main():
    assert sys.argv[1:] == ['verify-inputs']
    directory = Path('/source/legacy')
    roots = {}
    for root, expected in ROOTS.items():
        name = expected['name']
        metadata = json.loads((directory / (name + '.json')).read_text())[0]
        verify_archive(root, directory / (name + '.tar'), metadata)
        roots[root] = metadata
    verify_loaded(roots, inspect)
    print(json.dumps({'roots': roots, 'archivesAndLayersVerified': True}))


if __name__ == '__main__':
    main()
