#!/usr/bin/env python3
"""Regenerate publication tables with Python's Unicode 15.0 database."""
import json
from pathlib import Path
import re
import unicodedata as u

assert u.unidata_version == '15.0.0'
root = Path(__file__).resolve().parents[1] / 'deploy/sandbox'
# Unicode 15.0 Default_Ignorable_Code_Point, plus blank braille.
invisible = re.compile('[\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]')


def ranges(predicate):
    runs = []
    start = end = None
    for cp in range(0x110000):
        if predicate(chr(cp)):
            if start is None:
                start = cp
            end = cp
        elif start is not None:
            runs.append(chr(start) if start == end else chr(start) + '-' + chr(end))
            start = None
    if start is not None:
        runs.append(chr(start) if start == end else chr(start) + '-' + chr(end))
    return ''.join(runs)


data = {
    'version': '15.0.0',
    'javascript': {'15.0': ['72', '73'], '15.1': ['74', '75'],
                   '16.0': ['76', '77'], '17.0': ['78']},
    'letters': ranges(lambda c: u.category(c).startswith('L')),
    'marks': ranges(lambda c: u.category(c).startswith('M')),
    # Reject unassigned characters before normalization: newer runtimes must not
    # introduce new letters, marks, or compatibility decompositions to the policy.
    'forbidden': ranges(lambda c: c != '\n' and (
        u.category(c) in ('Cc', 'Cf', 'Cs', 'Cn') or invisible.fullmatch(c))),
}
(root / 'publication-unicode.json').write_text(json.dumps(data, indent=2) + '\n')
# Full mappings, including ordinary lowercase, avoid runtime casing drift.
fold = {chr(cp): chr(cp).casefold() for cp in range(0x110000)
        if chr(cp).casefold() != chr(cp)}
(root / 'casefold.json').write_text(json.dumps(fold, separators=(',', ':')) + '\n')
