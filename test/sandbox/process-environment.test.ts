import { expect, test } from "bun:test"
import { command } from "./harness"

test("credential inventory permits only Runner.Worker and never prints token values", async () => {
  expect(
    await command([
      "python3",
      "-c",
      `
import importlib.util,pathlib,tempfile,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('inventory','scripts/evidence/process-environment.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 root=pathlib.Path(root)
 def process(pid,exe,env):
  p=root/str(pid);p.mkdir();(p/'exe').symlink_to(exe);(p/'environ').write_bytes(env);(p/'cmdline').write_bytes(b'fixture\\0hold\\0')
 worker=root/'Runner.Worker';worker.touch()
 daemon=root/'tailscaled';daemon.touch()
 process(1,worker,b'ACTIONS_ID_TOKEN_REQUEST_TOKEN=secret-value\\0ACTIONS_ID_TOKEN_REQUEST_URL=secret-url\\0')
 result=m.scan_process_environments(root)
 assert result['oidcProcesses']==[] and result['runnerWorkers']==1
 process(2,daemon,b'ACTIONS_ID_TOKEN_REQUEST_TOKEN=secret-value\\0ACTIONS_ID_TOKEN_REQUEST_FUTURE=secret-url\\0')
 result=m.scan_process_environments(root)
 assert len(result['oidcProcesses'])==1
 assert result['oidcProcesses'][0]['names']==['ACTIONS_ID_TOKEN_REQUEST_FUTURE','ACTIONS_ID_TOKEN_REQUEST_TOKEN']
 assert 'secret-value' not in json.dumps(result) and 'secret-url' not in json.dumps(result)
 (root/'2'/'exe').unlink()
 try: m.scan_process_environments(root)
 except FileNotFoundError: pass
 else: raise AssertionError('unidentified persistent process was skipped')
print('passed')
`,
    ]),
  ).toBe("passed")
})

test("federation failures never include the identity token in diagnostics", async () => {
  expect(
    await command([
      "python3",
      "-c",
      `
import io,json,os,pathlib,subprocess,types,urllib.request
from unittest.mock import patch
script=pathlib.Path('deploy/sandbox/tailscale.sh').read_text().split("python3 - <<'PY'\\n")[1].split('\\nPY')[0]
env={'ACTIONS_ID_TOKEN_REQUEST_URL':'https://fixture.invalid/?request=1','ACTIONS_ID_TOKEN_REQUEST_TOKEN':'request-secret','SANDBOX_AUDIENCE':'fixture','SANDBOX_TAILSCALE_CLIENT_ID':'client','GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1'}
for status in [0,1]:
 with patch.dict(os.environ,env),patch('urllib.request.urlopen',return_value=io.StringIO(json.dumps({'value':'identity-secret'}))),patch('subprocess.run',return_value=types.SimpleNamespace(returncode=status)) as run:
  try: exec(script,{})
  except SystemExit as error:
   assert status==1 and str(error)=='Tailscale enrollment failed'
  else: assert status==0
  args,kwargs=run.call_args
  assert not any(k.startswith('ACTIONS_ID_TOKEN_REQUEST_') for k in kwargs['env'])
  assert '--accept-dns=false' in args[0] and '--accept-routes=false' in args[0]
print('passed')
`,
    ]),
  ).toBe("passed")
})
