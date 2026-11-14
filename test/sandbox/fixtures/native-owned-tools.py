#!/usr/bin/python3
"""Trusted fixture mappings; commands still execute real Git/netfilter programs."""
import os
from pathlib import Path
import sys

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
if tool == 'git':
    args = ['git://127.0.0.1:19418/source-fixture/source.git'
            if value == 'https://github.com/fixture/repo.git' else value for value in args]
    os.execv('/bin/git', ['/bin/git', *args])
elif tool in ['iptables', 'ip6tables']:
    assert os.readlink('/proc/self/ns/net') == Path('/evidence/inner-netns').read_text().strip()
    os.environ['XTABLES_LIBDIR'] = '/network-tools/usr/lib/xtables'
    os.execv('/network-tools/lib/ld-musl-x86_64.so.1', [
        '/network-tools/lib/ld-musl-x86_64.so.1', '--library-path',
        '/network-tools/lib:/network-tools/usr/lib', '/network-tools/xtables', tool, *args])
elif tool == 'sudo':
    assert os.getuid() == 0
    assert os.readlink('/proc/self/ns/net') == Path('/evidence/inner-netns').read_text().strip()
    assert args == ['-n', '/bin/bash', '/source/deploy/sandbox/network.sh', 'host', '172.30.0.0/24']
    os.execv(args[1], args[1:])
else:
    raise RuntimeError('Fixture command refused')
