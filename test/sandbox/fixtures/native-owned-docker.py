#!/usr/bin/python3
"""Translate only the fixture's immutable image and owned bind source path.
All operations still execute against the private engine. No result substitution.
"""
import os
from pathlib import Path
import re
import sys

image = Path('/evidence/agent-image-id').read_text().strip()
assert re.fullmatch('sha256:[a-f0-9]{64}', image)
reference = 'ghcr.io/bnasraoui/workflowd-agent-base@' + image
arguments = [image if value == reference else value for value in sys.argv[1:]]
arguments = [value.replace('source=/run/workflowd-sandbox/gateway.sock,',
                            'source=/evidence/native-runtime/gateway.sock,') for value in arguments]
if arguments == ['pull', image]:
    # The exact hash-verified local archive substitutes registry acquisition only.
    arguments = ['image', 'inspect', image]
os.execv('/tmp/docker', ['/tmp/docker', *arguments])
