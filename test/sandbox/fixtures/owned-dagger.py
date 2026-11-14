"""Real private Dagger API and nested-runtime control, with offline image input."""
import json
import pathlib
import subprocess
import sys
import uuid

root = pathlib.Path('/evidence')
queries = []
phase = sys.argv[1] if len(sys.argv) > 1 else 'runtime'


def query(text):
    index = len(queries)
    result = subprocess.run(['/source/dagger', 'query'], input=text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    (root / f'dagger-query-{phase}-{index}.stdout').write_text(result.stdout)
    (root / f'dagger-query-{phase}-{index}.stderr').write_text(result.stderr)
    queries.append({'query': text, 'exit': result.returncode})
    (root / ('dagger-queries-' + phase + '.json')).write_text(json.dumps(queries, indent=2))
    return result


result = query('{host{file(path:"/evidence/python-image.tar"){id}}}')
assert result.returncode == 0, 'Dagger host-file positive control failed'
file_id = json.loads(result.stdout)['host']['file']['id']
source = 'import(source:' + json.dumps(file_id) + ')'
if len(sys.argv) > 1 and sys.argv[1] != 'runtime':
    # This is the engine's host-only http() path, separate from nested CNI exec.
    phase = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else 'both'
    if mode != 'nested':
        process = subprocess.run(['/source/dagger', 'run', 'python3', '/source/owned-dagger-network.py', phase],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=100)
        (root / ('dagger-http-' + phase + '.stdout')).write_bytes(process.stdout)
        (root / ('dagger-http-' + phase + '.stderr')).write_bytes(process.stderr)
        assert process.returncode == 0, 'Engine http() boundary failed'
    if phase != 'restored' and mode != 'http':
        from native_network import DENIED, PUBLIC
        targets = [host for host in DENIED + PUBLIC if ':' not in host] + ['10.87.0.1']
        nested = '''import concurrent.futures,json,socket,sys
print(open('/etc/resolv.conf').read(),file=sys.stderr)
assert {x[4][0] for x in socket.getaddrinfo('fixture.invalid',8081,socket.AF_INET)}=={'192.0.2.2'}
targets=json.loads(sys.argv[1])
def probe(host):
 try:
  with socket.create_connection((host,1234 if host=='10.87.0.1' else 8081),timeout=3): pass
  result='connected'
 except TimeoutError: result='timeout'
 return dict(host=host,result=result)
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool: print(json.dumps(list(pool.map(probe,targets))))
'''
        # Each phase must execute a new probe, never replay Dagger's cached stdout.
        result = query('{container{' + source + '{withUser(name:"1000:1000"){withExec(args:' + json.dumps(['python3', '-c', nested, json.dumps(targets), uuid.uuid4().hex]) + '){stdout}}}}}')
        assert result.returncode == 0, 'Nested network probe failed'
        values = json.loads(json.loads(result.stdout)['container']['import']['withUser']['withExec']['stdout'])
        assert [value['host'] for value in values] == targets
        for value in values:
            expected = 'timeout' if phase == 'denied' and value['host'] not in PUBLIC else 'connected'
            assert value['result'] == expected, value
        (root / ('dagger-nested-' + phase + '.json')).write_text(json.dumps(values))
    raise SystemExit(0)
script = "import os,pathlib;assert os.getuid()==os.getgid()==1000;assert not any(pathlib.Path(p).exists() for p in ['/run/workflowd-engine/engine.sock','/var/run/docker.sock','/evidence']);print('nested-uid-1000')"
result = query('{container{' + source + '{withUser(name:"1000:1000"){withExec(args:' + json.dumps(['python3', '-c', script]) + '){stdout}}}}}')
assert result.returncode == 0, 'Real nested container failed'
assert json.loads(result.stdout)['container']['import']['withUser']['withExec']['stdout'].strip() == 'nested-uid-1000'
denied = query('{container{' + source + '{withExec(args:["true"],insecureRootCapabilities:true){stdout}}}}')
assert denied.returncode != 0 and 'security.insecure is not allowed' in denied.stderr, 'Insecure execution was not refused'
(root / 'dagger-receipt.json').write_text(json.dumps({'nestedUid1000': True, 'socketsAbsent': True, 'insecureEntitlementRefused': True}))
