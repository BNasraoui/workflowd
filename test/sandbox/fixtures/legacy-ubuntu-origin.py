#!/usr/bin/python3
"""Read-only, loopback-only origin for exactly the approved Ubuntu OCI objects."""
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import shutil
from urllib.parse import urlsplit

ROOT = '534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55'
MANIFEST = 'f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b'
CONFIG = '69f919497cada9a8611f3de61df902d9f94bf20f84552ef5bd93125c38608ef9'
LAYER = 'a60ef8ec184edb5ed91f5983f00261359fb2fe20f603e8d488b9477d32fcad70'
OBJECTS = {
    ROOT: (6688, 'application/vnd.oci.image.index.v1+json'),
    MANIFEST: (424, 'application/vnd.oci.image.manifest.v1+json'),
    CONFIG: (2052, 'application/vnd.oci.image.config.v1+json'),
    LAYER: (29764422, 'application/vnd.oci.image.layer.v1.tar+gzip'),
}


def main():
    directory = Path('/ubuntu')
    for digest, (size, _) in OBJECTS.items():
        file = directory / digest
        assert not file.is_symlink() and file.stat().st_size == size
        with file.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == digest
    routes = {f'/v2/library/ubuntu/{"manifests" if digest in [ROOT, MANIFEST] else "blobs"}/sha256:{digest}': digest for digest in OBJECTS}

    class Handler(BaseHTTPRequestHandler):
        requests = 0

        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def log_message(self, *_):
            pass

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            Handler.requests += 1
            if Handler.requests > 256:
                self.send_response(429)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            parsed = urlsplit(self.path)
            valid = not parsed.fragment and parsed.query in ['', 'ns=docker.io']
            digest = routes.get(parsed.path) if valid else None
            if valid and parsed.path == '/v2/':
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(b'{}')
            elif digest is not None:
                size, media_type = OBJECTS[digest]
                self.send_response(200)
                self.send_header('Content-Length', str(size))
                self.send_header('Content-Type', media_type)
                self.send_header('Docker-Content-Digest', 'sha256:' + digest)
                self.end_headers()
                if self.command != 'HEAD':
                    with (directory / digest).open('rb') as stream:
                        shutil.copyfileobj(stream, self.wfile, 65536)
            else:
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()
            print(json.dumps({'method': self.command, 'object': digest, 'accepted': digest is not None or (valid and parsed.path == '/v2/')}), flush=True)

    HTTPServer(('127.0.0.1', 5000), Handler).serve_forever()


if __name__ == '__main__':
    main()
