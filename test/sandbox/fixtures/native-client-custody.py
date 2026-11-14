#!/usr/bin/python3
"""Real exited child/group custody, wholly inside the isolated fixture namespace."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time

module_path = Path('deploy/sandbox/native-client.py').resolve()
if len(sys.argv) == 3 and sys.argv[1] == 'custodian':
    root = Path(sys.argv[2])
    spec = importlib.util.spec_from_file_location('native_client', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Substitute only the pinned executable/config adapter. Process custody is real.
    module.prepare = lambda value: None
    module.arguments = lambda value: ['/usr/bin/python3', str(root/'child.py')]
    popen, killpg = subprocess.Popen, os.killpg
    def launch(*args, **kwargs):
        child = popen(*args, **kwargs)
        (root/'leader').write_text(str(child.pid))
        return child
    def owned_signal(pid, sig):
        status = Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()
        assert int(status[1]) == os.getpid(), 'group leader custody released before signal'
        with (root/'signals.jsonl').open('a') as output:
            output.write(json.dumps({'signal': int(sig), 'leaderState': status[0], 'owned': True})+'\n')
        killpg(pid, sig)
    module.subprocess.Popen, module.os.killpg = launch, owned_signal
    module.run()
    raise SystemExit(0)

assert os.readlink('/proc/self/ns/net') != os.environ['WORKFLOWD_FIXTURE_HOST_NETNS']
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0  # Reap only our orphan fixture descendants.
operation = sys.argv[1]
assert operation in ['finish', 'cancel']
root = Path(tempfile.mkdtemp(prefix='native-group-', dir='/tmp/opencode/evidence'))
(root/'child.py').write_text(f'''
import json,subprocess
from pathlib import Path
child=subprocess.Popen(['/usr/bin/python3','-c','import time; time.sleep(60)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path({str(root/'descendant')!r}).write_text(str(child.pid))
print(json.dumps({{'type':'thread.started','thread_id':'11111111-2222-3333-4444-555555555555'}}),flush=True)
''')
process = subprocess.Popen(['/usr/bin/python3', __file__, 'custodian', str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ)
try:
    request = {'client':'codex','binary':'/usr/bin/python3','home':str(root/'home'),'workspace':str(root),'session':None,'model':'gpt-5.5','effort':'high','provider':'fixture','prompt':'Once','resume':False,'baseUrl':'http://127.0.0.1:12345','deadline':time.time()+10}
    process.stdin.write((json.dumps(request)+'\n').encode()); process.stdin.flush()
    assert selector.select(3), 'started receipt missing'
    started = json.loads(process.stdout.readline())
    assert started['event'] == 'started'
    pid = int((root/'leader').read_text())
    deadline = time.monotonic()+3
    while time.monotonic()<deadline:
        state = Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[0]
        if state == 'Z': break
        time.sleep(.01)
    assert state == 'Z', 'child did not exit'
    # Controller intent arrives after natural exit, including multiple observer iterations.
    time.sleep(.2)
    assert Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[0] == 'Z', 'leader reaped before controller intent'
    process.stdin.write((json.dumps({'operation':operation})+'\n').encode());process.stdin.flush()
    assert selector.select(3), 'closed receipt missing'
    closed = json.loads(process.stdout.readline())
    process.wait(timeout=3)
    assert process.returncode == 0, process.stderr.read()
    assert closed == {'event':'closed','session':started['session'],'outcome':'completed' if operation=='finish' else 'cancelled','exitCode':0}
    assert not Path(f'/proc/{pid}').exists(), 'leader not reaped after signals'
    signals = [json.loads(line) for line in (root/'signals.jsonl').read_text().splitlines()]
    assert signals and all(row['owned'] and row['leaderState']=='Z' for row in signals)
    descendant = int((root/'descendant').read_text())
    deadline = time.monotonic()+2
    while time.monotonic()<deadline:
        reaped, status = os.waitpid(descendant, os.WNOHANG)
        if reaped: break
        time.sleep(.01)
    assert reaped == descendant and os.WIFSIGNALED(status), 'descendant not joined'
    (root/'receipt.json').write_text(json.dumps({'operation':operation,'leaderHeldUntilCleanup':True,'leaderReaped':True,'descendantJoined':True,'signals':signals}))
finally:
    selector.close()
    if process.poll() is None:
        process.stdin.close()
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.kill();process.wait()
    # The enclosing namespace owns failed-fixture orphan teardown; never signal a released leader PID.
