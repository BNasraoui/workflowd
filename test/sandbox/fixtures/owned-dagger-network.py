"""Runs under dagger run; all HTTP destinations are owned synthetic listeners."""
import base64
import concurrent.futures
import json
import os
import pathlib
import sys
import urllib.request
import uuid
from native_network import DENIED, PUBLIC

phase = sys.argv[1]
# Dagger engine IPv6 is intentionally disabled by the production engine policy.
# Native Docker IPv6 is exercised independently by native-network.py.
targets = [host for host in DENIED + PUBLIC if ':' not in host]


def probe(host):
    url = 'http://' + host + ':8081/?fixture=' + uuid.uuid4().hex
    query = '{http(url:' + json.dumps(url) + '){contents}}'
    request = urllib.request.Request('http://127.0.0.1:' + os.environ['DAGGER_SESSION_PORT'] + '/query',
                                     data=json.dumps({'query': query}).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Basic ' + base64.b64encode((os.environ['DAGGER_SESSION_TOKEN'] + ':').encode()).decode()})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = json.load(response)
    errors = [error.get('message', '') for error in data.get('errors', [])]
    if errors and all('dial tcp ' + host + ':8081:' in message and ('i/o timeout' in message or 'connect: connection timed out' in message) for message in errors):
        result = 'timeout'
    elif (data.get('data') or {}).get('http', {}).get('contents') == 'fixture-http-reachable':
        result = 'connected'
    else:
        raise AssertionError(data)
    return {'host': host, 'result': result}


with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    values = list(pool.map(probe, targets))
for value in values:
    expected = 'timeout' if phase == 'denied' and value['host'] not in PUBLIC else 'connected'
    assert value['result'] == expected, value
pathlib.Path('/evidence/dagger-http-' + phase + '.json').write_text(json.dumps(values))
