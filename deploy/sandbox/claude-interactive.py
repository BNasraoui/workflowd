#!/usr/bin/env python3
"""The entry of a run's box: a loopback port for Claude Code and Git inside the box.

The box runs Claude Code in print mode (`claude -p`), the mode of the gateway's recorded
anthropic-beta list. Its only way out of the box is the run's relay, a Unix socket that the host
mounts at /run/workflowd-gateway.sock. Claude Code and Git speak HTTP to 127.0.0.1:31741; this
port passes a model call or a Git read of the run's own repository, with the fixed local sentinel
as its credential, and refuses anything else. The relay holds the run token, outside the box.
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import re
import signal
import socket
import sys
import threading

SOCKET = '/run/workflowd-gateway.sock'
SENTINEL = 'workflowd-local'
PORT = 31741
MODEL = re.compile(r'/v1/messages(?:/count_tokens)?(?:\?beta=true)?')
GIT = {
    'GET': re.compile(r'/capabilities/v1/git/[1-9][0-9]{0,15}\.git/info/refs\?service=git-upload-pack'),
    'POST': re.compile(r'/capabilities/v1/git/[1-9][0-9]{0,15}\.git/git-upload-pack'),
}
GIT_HEADERS = {'authorization', 'host', 'content-type', 'content-length', 'accept', 'accept-encoding',
               'accept-language', 'pragma', 'user-agent', 'git-protocol', 'connection'}
PASSED = {'authorization', 'content-type', 'anthropic-version', 'anthropic-beta',
          'x-claude-code-session-id', 'git-protocol'}


class Relay(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(120)
        self.sock.connect(SOCKET)


def refused(handler):
    """Whether a request is outside the port's routes or headers."""
    git = handler.command in GIT and GIT[handler.command].fullmatch(handler.path) is not None
    model = handler.command == 'POST' and MODEL.fullmatch(handler.path) is not None
    length = handler.headers.get('Content-Length', '0' if handler.command == 'GET' else '')
    return (not (git or model) or
            handler.headers.get_all('Authorization') != ['Bearer ' + SENTINEL] or
            (handler.headers.get_all('Content-Length') is not None and
             handler.headers.get_all('Content-Length') != [length]) or
            not length.isdecimal() or int(length) > 1048576 or
            (handler.command == 'GET' and int(length) != 0) or
            (git and (handler.headers.get_all('Host') != ['127.0.0.1:' + str(PORT)] or
                      any(k.lower() not in GIT_HEADERS for k in handler.headers) or
                      handler.headers.get('Connection', 'close').lower() not in ['close', 'keep-alive'])) or
            handler.headers.get('Transfer-Encoding') is not None or
            handler.headers.get('x-api-key') is not None or
            sum(len(k) + len(v) for k, v in handler.headers.items()) > 8192)


def serve():
    slots = threading.BoundedSemaphore(4)

    class Port(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def forward(self):
            if refused(self):
                self.send_error(403)
                return
            if not slots.acquire(blocking=False):
                self.send_error(429)
                return
            relay = Relay('capability.invalid', timeout=120)
            try:
                self.connection.settimeout(10)
                length = int(self.headers.get('Content-Length', '0'))
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError('Truncated request')
                headers = {key: value for key, value in self.headers.items() if key.lower() in PASSED}
                relay.request(self.command, self.path, body, headers)
                response = relay.getresponse()
                self.send_response(response.status)
                for key in ['content-type', 'request-id', 'retry-after']:
                    value = response.getheader(key)
                    if value is not None:
                        self.send_header(key, value)
                self.send_header('Connection', 'close')
                self.end_headers()
                count = 0
                while chunk := response.read1(65536):
                    count += len(chunk)
                    if count > 32 * 1048576:
                        raise ValueError('Response capacity')
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except Exception:
                self.close_connection = True
            finally:
                relay.close()
                slots.release()

    server = ThreadingHTTPServer(('127.0.0.1', PORT), Port)
    server.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server.serve_forever(poll_interval=0.05)


if __name__ == '__main__':
    try:
        if sys.argv[1:] != ['serve']:
            raise ValueError('Unknown operation')
        serve()
    except Exception:
        # The box's own output; a reason of Python may hold request bytes.
        sys.exit(1)
