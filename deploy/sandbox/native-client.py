#!/usr/bin/env python3
"""Runner-host custody for pinned Codex/OpenCode CLI invocations.

Native JSON supplies an endpoint identifier only. Completion requires controller
intent, joined real process exit, then the supervisor's whole-container stop.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

PINS = {
    'codex': 'f1cd7fa4ac866c724122f173d408a95385257cbcc9ac5ce5ddba42669c74ba97',
    'opencode2': '5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c',
}


def emit(event, **fields):
    print(json.dumps({'event': event, **fields}), flush=True)


def session_valid(client, session):
    return isinstance(session, str) and re.fullmatch(r'[a-f0-9-]{36}' if client == 'codex' else r'ses_[A-Za-z0-9]{20,64}', session)


def prepare(value):
    client, home = value['client'], Path(value['home'])
    binary = Path(value['binary'])
    with binary.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != PINS[client]:
            raise ValueError('Native executable pin refused')
    home.mkdir(mode=0o700, exist_ok=True)
    base = value['baseUrl'] + '/capabilities/v1/providers/' + value['provider']
    if client == 'codex':
        directory = home / '.codex'
        directory.mkdir(mode=0o700, exist_ok=True)
        def encode(data): return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')
        identity = encode({'alg': 'none'}) + '.' + encode({'exp': 4102444800, 'https://api.openai.com/auth': {'chatgpt_plan_type': 'plus', 'chatgpt_account_id': 'workflowd-local-account'}}) + '.local'
        # Surrogate local auth only. The gateway supplies canonical ChatGPT access
        # and account headers on Mint; no rotating grant enters this HOME.
        (directory / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'id_token': identity, 'access_token': 'workflowd-local', 'refresh_token': 'unused-local-sentinel', 'account_id': 'workflowd-local-account'}, 'last_refresh': '2099-01-01T00:00:00Z'}))
        config = [
            'model_provider="workflowd"', 'cli_auth_credentials_store="file"',
            'chatgpt_base_url=' + json.dumps(value['baseUrl']), 'web_search="disabled"',
            '[analytics]', 'enabled=false', '[features]', 'enable_request_compression=false',
            'apps=false', 'plugins=false', 'remote_plugin=false', 'multi_agent=false',
            'image_generation=false', 'goals=false', 'remote_compaction_v2=false',
            '[model_providers.workflowd]', 'name="workflowd"', 'base_url=' + json.dumps(base),
            'wire_api="responses"', 'requires_openai_auth=true', 'supports_websockets=false',
            'request_max_retries=0', 'stream_max_retries=0',
        ]
        (directory / 'config.toml').write_text('\n'.join(config) + '\n')
    else:
        directory = home / 'config/opencode'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        (directory / 'opencode.json').write_text(json.dumps({
            '$schema': 'https://opencode.ai/config.json', 'update': 'disable', 'share': 'disabled',
            'snapshots': False, 'formatter': False, 'lsp': False,
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'deny'}, *[{'action': action, 'resource': '*', 'effect': 'allow'} for action in ['shell', 'read', 'edit', 'glob', 'grep']]],
            'providers': {value['provider']: {
                'package': 'aisdk:@ai-sdk/openai-compatible',
                'settings': {'baseURL': base, 'apiKey': 'workflowd-local'},
                'body': {'reasoning_effort': value['effort']},
                'models': {value['model']: {'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']}, 'limit': {'context': 100000, 'output': 4096}}},
            }},
        }))


def arguments(value):
    if value['client'] == 'codex':
        args = [value['binary'], '-c', 'model_provider="workflowd"', '-c', 'model_reasoning_effort=' + json.dumps(value['effort']), 'exec']
        if value['resume']: args += ['resume', value['session']]
        args += ['--model', value['model'], '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--', value['prompt']]
    else:
        args = [value['binary'], 'run', '--standalone', '--format', 'json', '--model', value['provider'] + '/' + value['model']]
        if value['resume']: args += ['--session', value['session']]
        # beta-19242 repeats positional text after `--`; a fixed leading label
        # keeps the single positional prompt from being parsed as an option.
        args += ['Task:\n' + value['prompt']]
    return args


def run():
    os.umask(0o077)
    raw = sys.stdin.buffer.readline(1048577)
    if len(raw) > 1048576 or not raw.endswith(b'\n'): raise ValueError('Native launch capacity')
    value = json.loads(raw)
    expected = {'client','binary','home','workspace','session','model','effort','provider','prompt','resume','baseUrl','deadline'}
    if set(value) - {'container'} != expected or value['client'] not in PINS: raise ValueError('Native launch refused')
    if any(not isinstance(value[k], str) or not Path(value[k]).is_absolute() for k in ['binary','home','workspace']): raise ValueError('Native paths refused')
    if not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}', value['baseUrl']): raise ValueError('Loopback required')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['provider']): raise ValueError('Provider refused')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value['model']) or value['effort'] not in ['low','medium','high','xhigh']: raise ValueError('Selection refused')
    if value['client'] == 'codex' and value['model'] != 'gpt-5.5': raise ValueError('Unsupported pinned model profile')
    if type(value['resume']) is not bool or value['resume'] and not session_valid(value['client'], value['session']): raise ValueError('Resume refused')
    if not isinstance(value['prompt'], str) or not value['prompt']: raise ValueError('Prompt required')
    if not time.time() < value['deadline'] <= time.time() + 285*60: raise ValueError('Deadline refused')
    env = {'PATH': os.environ['PATH'], 'HOME': value['home'], 'LANG': 'C.UTF-8',
        'TMPDIR': os.environ.get('TMPDIR', '/tmp'), 'CODEX_HOME': value['home']+'/.codex',
        **{'XDG_'+kind+'_HOME': value['home']+'/'+kind.lower() for kind in ['CONFIG','DATA','CACHE','STATE']},
        'OPENCODE_CONFIG_PROJECT_DISABLE': '1', 'OPENCODE_DISABLE_PROJECT_CONFIG': '1',
        'OPENCODE_DISABLE_MODELS_FETCH': 'true', 'OPENCODE_DISABLE_AUTOUPDATE': 'true',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
        'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': '/dev/null',
        'GIT_AUTHOR_NAME': 'Workflowd Agent', 'GIT_COMMITTER_NAME': 'Workflowd Agent',
        'GIT_AUTHOR_EMAIL': 'agent@workflowd.invalid', 'GIT_COMMITTER_EMAIL': 'agent@workflowd.invalid',
        'WORKFLOWD_GATEWAY_URL': value['baseUrl'], 'WORKFLOWD_GATEWAY_SENTINEL': 'workflowd-local',
        **{k:os.environ[k] for k in ['NIX_LD','NIX_LD_LIBRARY_PATH'] if k in os.environ}}
    if 'container' in value:
        if not re.fullmatch(r'workflowd-native-[a-f0-9]{64}', value['container']): raise ValueError('Container refused')
        args = ['/usr/bin/docker','exec','--interactive','--user','1000:1000','--workdir',value['workspace']]
        for key, item in env.items(): args += ['--env', key+'='+item]
        args += [value['container'], '/bin/python3','/opt/workflowd/native-client.py','exec',json.dumps({k:v for k,v in value.items() if k!='container'})]
    else:
        prepare(value)
        args = arguments(value)
    child = subprocess.Popen(args, cwd=None if 'container' in value else value['workspace'], env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent'} if 'container' in value else env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    for stream in [child.stdout,child.stderr,sys.stdin.buffer]: selector.register(stream,selectors.EVENT_READ)
    buffers = {child.stdout:b'',sys.stdin.buffer:b''}
    output_open = 2
    size, selected, operation = 0, None, None
    deadline, outcome = value['deadline'], 'operator_required'
    cancelled = False
    def cancel(*_):
        nonlocal cancelled
        cancelled = True
    for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]: signal.signal(sig,cancel)
    def exit_status():
        # WNOWAIT retains the leader (and thus its PID/PGID) until all group
        # signals are finished. Popen.poll/wait would release that authority.
        status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        return None if status is None else status.si_status if status.si_code == os.CLD_EXITED else -status.si_status
    try:
        while time.time()<deadline and not cancelled:
            code = exit_status()
            if operation and code is not None and output_open == 0:
                if code==0 and selected: outcome='paused' if operation=='pause' else 'completed'
                break
            for key,_ in selector.select(.05):
                stream=key.fileobj
                data=os.read(stream.fileno(),65536 if stream!=sys.stdin.buffer else 4097)
                if not data:
                    selector.unregister(stream)
                    if stream==sys.stdin.buffer: cancelled=True
                    else: output_open-=1
                    continue
                if stream!=sys.stdin.buffer:
                    size+=len(data)
                    if size>1048576: raise ValueError('Native output capacity')
                    sys.stderr.buffer.write(data);sys.stderr.buffer.flush()
                if stream==child.stderr: continue
                buffers[stream]+=data
                if len(buffers[stream])>(1048576 if stream==child.stdout else 4096): raise ValueError('Native record capacity')
                while b'\n' in buffers[stream]:
                    line,buffers[stream]=buffers[stream].split(b'\n',1)
                    item=json.loads(line)
                    if stream==sys.stdin.buffer:
                        if item=={'operation':'cancel'}: cancelled=True
                        elif selected and not operation and item in [{'operation':'pause'},{'operation':'finish'}]:
                            operation=item['operation'];deadline=min(deadline,time.time()+5)
                        else: raise ValueError('Native control refused')
                    elif selected is None:
                        session=item.get('thread_id') if item.get('type')=='thread.started' else item.get('sessionID') if value['client']=='opencode2' else None
                        if session is None: continue
                        if not session_valid(value['client'],session) or value['resume'] and session!=value['session']: raise ValueError('Native session refused')
                        selected=session
                        emit('started',session=session)
            if code not in [None,0]: break
        if cancelled: outcome='cancelled'
    finally:
        selector.close()
        try: os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        until = time.monotonic()+1
        while exit_status() is None and time.monotonic()<until: time.sleep(.01)
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait(timeout=1)
        child.stdout.close();child.stderr.close()
    if selected: emit('closed',session=selected,outcome=outcome,exitCode=child.returncode)
    else: raise ValueError('Native session unavailable')


if __name__ == '__main__':
    try:
        if len(sys.argv)==3 and sys.argv[1]=='exec':
            if os.getuid()!=1000 or os.getgid()!=1000: raise ValueError('Native UID refused')
            value=json.loads(sys.argv[2]);prepare(value)
            os.execve(value['binary'],arguments(value),dict(os.environ))
        elif len(sys.argv)==1: run()
        else: raise ValueError('Native operation refused')
    except Exception:
        emit('failed');sys.exit(1)
