"""Run the whole shell command against a local filesystem-backed Docker boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

# The boundary models engine state, not the command's expected exit status.
# In particular, exec runs the actual prerequisite shell and image inspect tests
# real marker existence. No system manager, daemon or native model is launched.
docker = r'''#!/usr/bin/python3
import json,os,pathlib,subprocess,sys
root=pathlib.Path('/evidence');args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as f:f.write(json.dumps(args)+'\n')
if args[:2]==['image','load']:pass
elif args[:2]==['image','inspect']:
    assert args[2] in ['workflowd-sandbox-runner:fixture','workflowd-sandbox-tooling:fixture']
    sys.exit(0 if (root/args[2]).exists() else 1)
elif args[0]=='create':
    (root/'container').touch();print('c'*64)
elif args[0]=='inspect':
    assert (root/'container').exists()
    print('private 5368709120 5368709120 768' if '--format' in args else '{}')
elif args[0]=='exec':
    assert (root/'container').exists()
    if args[2:4]==['/bin/sh','-ec']:
        assert '--probe-supervision' in args[4]
    else:
        assert args[2:4]==['/bin/sh','-c'] and 'command -v' in args[4]
        sys.exit(subprocess.run(args[2:],env=os.environ).returncode)
elif args[0]=='rm':
    if (root/'refuse-removal').exists():sys.exit(23)
    (root/'container').unlink()
elif args[0] in ['start','stop','wait','logs']:assert (root/'container').exists()
else:raise AssertionError(args)
'''
scenario=sys.argv[1]
assert scenario in ['runner-missing','tooling-missing','present','tool-missing','cleanup-failure']
with tempfile.TemporaryDirectory(prefix='owned-systemd-prerequisite-') as temporary:
    root=Path(temporary);evidence=root/'evidence';tools=root/'tools'
    evidence.mkdir();tools.mkdir()
    (tools/'docker').write_text(docker);(tools/'docker').chmod(0o755)
    for name in ['bun','node','git','python3','ssh','sshd','openssl','curl','jq','setpriv','unshare','bash','claude','codex','opencode2']:
        if name=='claude' and scenario=='tool-missing':continue
        (tools/name).symlink_to('/bin/false')
    for name in ['runner','tooling']:
        if scenario!=name+'-missing':(evidence/('workflowd-sandbox-'+name+':fixture')).touch()
    if scenario=='cleanup-failure':(evidence/'refuse-removal').touch()
    (evidence/'systemd-image-id').write_text('sha256:'+'a'*64)
    env={'PATH':str(tools)+':/usr/bin:/bin','HOME':temporary,'DOCKER_HOST':'unix:///run/owned-engine/docker.sock','FIXTURE_OWNER':'fixture','FIXTURE_CASE':'systemd','WORKFLOWD_FIXTURE_SYSTEMD_SUITE':'prerequisites','HOST_NETNS':'absent-fixture-netns','HOST_CGROUPNS':'absent-fixture-cgroupns'}
    mounts=['/usr/bin/setpriv','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','/usr/bin/bwrap','--unshare-user','--tmpfs','/']
    for path in ['/usr','/bin','/lib','/lib64',str(Path.cwd())]:mounts.extend(['--ro-bind',path,path])
    mounts.extend(['--proc','/proc','--dev','/dev','--bind',temporary,temporary,'--bind',str(evidence),'/evidence','--ro-bind',str(tools),'/source/bin','--chdir',str(Path.cwd())])
    result=subprocess.run([*mounts,'--','/bin/sh','scripts/evidence/owned-systemd.sh'],env=env,text=True,capture_output=True,timeout=10)
    assert (evidence/'calls.jsonl').exists(),result.stderr
    expected=0 if scenario=='present' else 23 if scenario=='cleanup-failure' else 1
    calls=[json.loads(line) for line in (evidence/'calls.jsonl').read_text().splitlines()]
    assert [a[2] for a in calls if a[:2]==['image','inspect']]==['workflowd-sandbox-runner:fixture','workflowd-sandbox-tooling:fixture']
    assert calls[-1]==['rm','c'*64]
    assert (evidence/'container').exists()==(scenario=='cleanup-failure')
    tools_log=(evidence/'remaining-tool-prerequisites.log').read_text()
    assert ('claude missing' in tools_log)==(scenario=='tool-missing')
    image_log=(evidence/'remaining-image-prerequisites.log').read_text()
    for name in ['runner','tooling']:
        state='missing' if scenario==name+'-missing' else 'present'
        assert f'workflowd-sandbox-{name}:fixture {state}' in image_log
    if result.returncode!=expected:
        print(json.dumps({'scenario':scenario,'expectedExit':expected,'actualExit':result.returncode,'stderr':result.stderr}));sys.exit(1)
    print(json.dumps({'scenario':scenario,'verified':True,'commandExit':result.returncode,'cleanupAttempted':True}))
