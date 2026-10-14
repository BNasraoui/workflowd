"""Exercise the installed gh binary and process isolation without external traffic."""
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_verified_deploy import d


class RuntimeTests(unittest.TestCase):
    def test_real_gh_argument_list_and_paginated_output(self):
        paths = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                second = 'page=2' in self.path
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                if not second:
                    self.send_header('Link', '<https://api.github.com/repos/BNasraoui/workflowd/fixture?page=2>; rel="next"')
                self.end_headers()
                self.wfile.write(json.dumps({'check_runs': [{'id': 2 if second else 1}]}).encode())

            def log_message(self, *args):
                pass

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            socket = root / 'api.sock'
            # gh's own Unix socket transport keeps the real argv completely unchanged.
            (root / 'config.yml').write_text(f'http_unix_socket: {socket}\n')
            with socketserver.UnixStreamServer(str(socket), Handler) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    with patch.dict(os.environ, {'PATH': '/usr/bin:/bin', 'HOME': directory,
                                                'GH_CONFIG_DIR': directory, 'GH_TOKEN': 'fixture'}, clear=True):
                        self.assertEqual(d.api('fixture', 'check_runs'), [{'id': 1}, {'id': 2}])
                finally:
                    server.shutdown()
                    thread.join()
            self.assertEqual(len(paths), 2)

    def test_runtime_uses_only_file_token_and_empty_global_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / 'token'
            token.write_text('dedicated-read-only-fixture\n')
            token.chmod(0o600)
            isolated = root / 'isolated'
            isolated.mkdir()
            with patch.dict(os.environ, {'GH_TOKEN': 'owner-token', 'GITHUB_TOKEN': 'owner-token',
                                         'PATH': '/agent/bin', 'HOME': '/owner',
                                         'BUN_INSTALL_CACHE_DIR': '/agent/cache',
                                         'GIT_CONFIG_COUNT': '1', 'HTTPS_PROXY': 'evil'}, clear=True):
                d.configure_environment(token, isolated)
                self.assertEqual(os.environ['GH_TOKEN'], 'dedicated-read-only-fixture')
                self.assertEqual(os.environ['PATH'], '/usr/bin:/bin')
                for key in ['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']:
                    self.assertEqual(os.environ[key], str(isolated))
                for key in ['GITHUB_TOKEN', 'BUN_INSTALL_CACHE_DIR', 'GIT_CONFIG_COUNT', 'HTTPS_PROXY']:
                    self.assertNotIn(key, os.environ)
            token.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'private'):
                d.configure_environment(token, isolated)
            token.chmod(0o600)
            link = root / 'link'
            link.symlink_to(token)
            with self.assertRaises(ValueError):
                d.configure_environment(link, isolated)

    def test_toolchain_preflight_reports_versions_and_refuses_old_tools(self):
        versions = {'git': 'git version 2.43.0', 'gh': 'gh version 2.45.0 (fixture)',
                    '/operator/bun': '1.3.14'}
        with patch.object(d, 'command', side_effect=lambda name, flag: versions[name]):
            d.check_toolchain(Path('/operator/bun'))
            for name, bad in [('gh', 'gh version 2.44.0'), ('git', 'git version 2.30.0'),
                              ('/operator/bun', '1.3.13')]:
                old = versions[name]
                versions[name] = bad
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'version'):
                    d.check_toolchain(Path('/operator/bun'))
                versions[name] = old
