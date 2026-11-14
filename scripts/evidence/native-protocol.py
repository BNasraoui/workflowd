#!/usr/bin/env python3
"""Offline pinned-client protocol discovery. Run only through isolated-fixture.py."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import selectors
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    client = sys.argv[1]
    assert client in ['codex', 'opencode2']
    assert os.readlink('/proc/self/ns/net') != os.environ['WORKFLOWD_FIXTURE_HOST_NETNS']
    root = Path('/tmp/opencode/evidence') / client
    root.mkdir(mode=0o700)
    home, work = root / 'home', root / 'work'
    home.mkdir(); work.mkdir()
    requests = []
    turns = 0
    turn_complete = threading.Event()
    sleeping = threading.Event()
    lifecycle = '--custodian' in sys.argv

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def do_GET(self):
            requests.append({'method': 'GET', 'path': self.path, 'headers': dict(self.headers)})
            self.send_response(403); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{}')

        def do_POST(self):
            nonlocal turns
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            requests.append({'method': 'POST', 'path': self.path, 'headers': dict(self.headers), 'body': body.decode(errors='replace')})
            data = json.loads(body)
            if not self.path.endswith('/responses' if client == 'codex' else '/chat/completions'):
                self.send_response(403);self.end_headers();return
            tools = data.get('tools', [])
            if tools: turns += 1
            call = 'call_' + str(turns)
            action = turns in ([1,2,4,5,7] if lifecycle else [1,2]) and tools
            command = 'printf "turn-' + str(turns) + '\\n" >> native-proof.txt'
            if lifecycle and turns == 7:
                command = 'touch sleep-start; sleep 90; touch must-not-finish'
                sleeping.set()
            if client == 'codex':
                names = [t.get('name', t.get('type')) for t in tools]
                name = next((n for n in ['exec_command', 'shell_command', 'shell'] if n in names), 'exec_command')
                args = {'command': command} if name == 'shell_command' else {'command': ['sh', '-c', command]} if name == 'shell' else {'cmd': command, 'yield_time_ms': 1000}
                item = {'type': 'function_call', 'id': call, 'call_id': call, 'name': name, 'arguments': json.dumps(args), 'status': 'completed'} if action else {'type': 'message', 'id': call, 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'fixture complete', 'annotations': []}]}
                def event(kind, **value): return 'event: '+kind+'\ndata: '+json.dumps({'type':kind,**value})+'\n\n'
                output = event('response.created', response={'id':call,'status':'in_progress','output':[]})
                output += event('response.output_item.added', output_index=0, item=item)
                output += event('response.output_item.done', output_index=0, item=item)
                output += event('response.completed', response={'id':call,'model':data['model'],'status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}})
            else:
                names = [t.get('function', {}).get('name') for t in tools]
                name = 'shell' if 'shell' in names else 'execute'
                args = {'command':command,'description':'Fixture tool'} if name == 'shell' else {'code':'return await tools.shell('+json.dumps({'command':command,'description':'Fixture tool'})+')'}
                delta = {'role':'assistant','tool_calls':[{'index':0,'id':call,'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]} if action else {'role':'assistant','content':'fixture complete'}
                def chunk(delta, finish): return 'data: '+json.dumps({'id':call,'object':'chat.completion.chunk','model':data['model'],'choices':[{'index':0,'delta':delta,'finish_reason':finish}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})+'\n\n'
                output = chunk(delta,None)+chunk({},'tool_calls' if action else 'stop')+'data: [DONE]\n\n'
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Content-Length',str(len(output.encode()))); self.end_headers(); self.wfile.write(output.encode())
            if tools and not action: turn_complete.set()

    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base = 'http://127.0.0.1:'+str(server.server_port)
    env = {k:v for k,v in os.environ.items() if k in ['PATH','LANG','TMPDIR','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL']}
    env.update(HOME=str(home),CODEX_HOME=str(home/'.codex'),XDG_CONFIG_HOME=str(home/'config'),XDG_DATA_HOME=str(home/'data'),XDG_CACHE_HOME=str(home/'cache'),XDG_STATE_HOME=str(home/'state'),OPENCODE_DISABLE_PROJECT_CONFIG='1',OPENCODE_CONFIG_PROJECT_DISABLE='1',OPENCODE_DISABLE_MODELS_FETCH='true',OPENCODE_DISABLE_AUTOUPDATE='true')
    if client == 'codex':
        codex = home/'.codex';codex.mkdir()
        def token(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
        jwt = token({'alg':'none'})+'.'+token({'exp':4102444800,'https://api.openai.com/auth':{'chatgpt_plan_type':'plus','chatgpt_account_id':'local-sentinel-account'}})+'.fixture'
        (codex/'auth.json').write_text(json.dumps({'auth_mode':'chatgpt','tokens':{'id_token':jwt,'access_token':'workflowd-local','refresh_token':'unused-synthetic','account_id':'local-sentinel-account'},'last_refresh':'2099-01-01T00:00:00Z'}))
        (codex/'config.toml').write_text('model="gpt-5.6-sol"\nmodel_reasoning_effort="high"\nmodel_provider="workflowd"\nchatgpt_base_url="'+base+'/backend-api"\ncli_auth_credentials_store="file"\nweb_search="disabled"\n[analytics]\nenabled=false\n[features]\nenable_request_compression=false\napps=false\nplugins=false\nremote_plugin=false\nmulti_agent=false\nimage_generation=false\ngoals=false\nremote_compaction_v2=false\n[model_providers.workflowd]\nname="workflowd"\nbase_url="'+base+'/backend-api/codex"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n')
        args = ['codex','exec','--model','gpt-5.5','--json','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','Perform the offline fixture tools.']
    else:
        config = home/'config/opencode';config.mkdir(parents=True)
        (config/'opencode.json').write_text(json.dumps({'update':'disable','share':'disabled','snapshots':False,'formatter':False,'lsp':False,'providers':{'fixture':{'package':'aisdk:@ai-sdk/openai-compatible','settings':{'apiKey':'workflowd-local','baseURL':base+'/v1'},'models':{'fixture':{'capabilities':{'tools':True,'input':['text'],'output':['text']},'limit':{'context':100000,'output':1024}}}}}}))
        args = ['opencode2','run','--standalone','--auto','--format','json','--model','fixture/fixture','Perform the offline fixture tools.']
    try:
        if lifecycle:
            events = []
            script = Path(__file__).resolve().parents[2]/'deploy/sandbox/native-client.py'
            def invoke(session, prompt, operation):
                turn_complete.clear();sleeping.clear()
                process = subprocess.Popen(['python3','-I',str(script)],cwd=work,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
                config = {'client':client,'binary':os.environ['WORKFLOWD_FIXTURE_'+client.upper()], 'home':str(home), 'workspace':str(work), 'session':session,'model':'gpt-5.5' if client=='codex' else 'fixture','effort':'high','provider':'fixture','prompt':prompt,'resume':session is not None,'baseUrl':base,'deadline':time.time()+50}
                process.stdin.write((json.dumps(config)+'\n').encode());process.stdin.flush()
                selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
                try:
                    assert selector.select(15), 'native start timed out'
                    line=process.stdout.readline();assert line, 'native exited before start'
                    start=json.loads(line);assert start['event']=='started';events.append(start)
                    if operation=='cancel':
                        assert sleeping.wait(15)
                        deadline=time.monotonic()+5
                        while not (work/'sleep-start').exists() and time.monotonic()<deadline: time.sleep(.01)
                        assert (work/'sleep-start').exists()
                    else: assert turn_complete.wait(20), 'tool turns missing'
                    process.stdin.write((json.dumps({'operation':operation})+'\n').encode());process.stdin.flush()
                    assert selector.select(10), 'native close timed out'
                    stdout=process.stdout.readline()
                    process.wait(timeout=3)
                    stderr=process.stderr.read()
                    (root/('custodian-'+operation+'.stderr')).write_bytes(stderr)
                    assert process.returncode==0, 'native custodian failed'
                    close=json.loads(stdout);events.append(close)
                    assert close['event']=='closed' and close['session']==start['session']
                    assert close['outcome']=={'pause':'paused','finish':'completed','cancel':'cancelled'}[operation]
                    return start['session']
                finally:
                    selector.close()
                    if process.poll() is None: process.kill()
                    process.wait(timeout=3)
            session=invoke(None,'INITIAL-UNIQUE-PROMPT','pause')
            assert invoke(session,'CONTINUATION-UNIQUE-PROMPT','pause')==session
            assert (work/'native-proof.txt').read_text()=='turn-1\nturn-2\nturn-4\nturn-5\n'
            assert invoke(session,'CANCEL-UNIQUE-PROMPT','cancel')==session
            assert not (work/'must-not-finish').exists()
            inference=[json.loads(r['body']) for r in requests if r.get('body') and ('/responses' in r['path'] or '/chat/completions' in r['path'])]
            resumed=next(b for b in inference if 'CONTINUATION-UNIQUE-PROMPT' in json.dumps(b))
            assert json.dumps(resumed).count('INITIAL-UNIQUE-PROMPT')==1, 'initial prompt replay'
            (root/'lifecycle.json').write_text(json.dumps({'events':events,'sameSession':True,'noInitialReplay':True,'sleepingToolCancelled':True}))
            return
        result = subprocess.run(args,cwd=work,env=env,capture_output=True,timeout=75)
        (root/'stdout').write_bytes(result.stdout);(root/'stderr').write_bytes(result.stderr)
        (root/'result.json').write_text(json.dumps({'exit':result.returncode,'requests':len(requests),'turns':turns,'proof':(work/'native-proof.txt').read_text() if (work/'native-proof.txt').exists() else None}))
    finally:
        (root/'requests.json').write_text(json.dumps(requests,indent=2));server.shutdown();server.server_close();thread.join()
    assert result.returncode == 0 and (work/'native-proof.txt').read_text() == 'turn-1\nturn-2\n'


if __name__ == '__main__': main()
