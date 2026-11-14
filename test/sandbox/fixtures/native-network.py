"""Synthetic listeners and UID-1000 probes; only the owned offline Docker fixture."""
import concurrent.futures
import json
import os
import socket
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8080
DENIED = [
    "172.30.0.1", "192.0.2.1", "10.23.0.2", "172.20.0.2", "192.168.23.2",
    "169.254.169.254", "168.63.129.16", "100.64.0.9", "198.51.100.2",
    "2001:db8:30::1", "2001:db8:1::1", "fd7a:115c:a1e0::2", "2001:db8:2::2",
]
PUBLIC = ["192.0.2.2", "2001:db8:1::2"]


def serve_tcp(family):
    with socket.socket(family, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if family == socket.AF_INET6:
            server.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        server.bind(("::" if family == socket.AF_INET6 else "0.0.0.0", PORT))
        server.listen(32)
        while True:
            connection, _ = server.accept()
            with connection:
                connection.sendall(b"fixture-reachable\n")


def serve_dns():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
        server.bind(("0.0.0.0", 53))
        while True:
            data, address = server.recvfrom(512)
            # Ignore EDNS/additional records, but answer the exact bounded question.
            # Dagger's resolver adds OPT records and tries its search suffix first.
            if len(data) < 17 or struct.unpack('!H', data[4:6])[0] != 1:
                continue
            labels, offset = [], 12
            while offset < len(data) and 0 < data[offset] <= 63:
                length = data[offset]
                labels.append(data[offset + 1:offset + 1 + length])
                offset += length + 1
            if offset + 5 > len(data) or data[offset] != 0:
                continue
            question = data[12:offset + 5]
            known = b'.'.join(labels).lower() == b'fixture.invalid'
            print(json.dumps({'dnsQuestion': b'.'.join(labels).decode('ascii', errors='replace')}), flush=True)
            answer = known and data[offset + 1:offset + 5] == b'\x00\x01\x00\x01'
            reply = data[:2] + struct.pack("!5H", 0x8180 if known else 0x8183, 1, int(answer), 0, 0) + question
            if answer:
                reply += b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 30, 4) + socket.inet_aton("192.0.2.2")
            server.sendto(reply, address)


def serve_http():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            body = b'fixture-http-reachable'
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6

    Server(('::', 8081), Handler).serve_forever()


def probe(host):
    try:
        with socket.create_connection((host, PORT), timeout=2) as connection:
            assert connection.recv(64) == b"fixture-reachable\n"
        result = "connected"
    except TimeoutError:
        result = "timeout"
    # Refusal, missing route, and listener failure must fail rather than count as denial.
    return {"host": host, "result": result}


def check():
    assert os.getuid() == os.getgid() == 1000
    for path in ["/var/run/docker.sock", "/run/owned-engine/docker.sock", "/evidence"]:
        assert not os.path.exists(path)
    status = open("/proc/self/status").read()
    assert "CapEff:\t0000000000000000" in status and "NoNewPrivs:\t1" in status
    targets = DENIED + PUBLIC
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(probe, targets))
    for record in results:
        expected = "timeout" if sys.argv[1] == "denied" and record["host"] in DENIED else "connected"
        assert record["result"] == expected, record
    assert {x[4][0] for x in socket.getaddrinfo("fixture.invalid", PORT, socket.AF_INET)} == {"192.0.2.2"}
    # An agent lacks CAP_NET_ADMIN even though its enclosing fixture is privileged.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        import fcntl
        try:
            fcntl.ioctl(control, 0x8914, struct.pack("16sH", b"eth0", 0))  # SIOCSIFFLAGS
        except PermissionError:
            pass
        else:
            raise AssertionError("Agent changed its interface flags")
    print(json.dumps({"uid": os.getuid(), "gid": os.getgid(), "dns": "resolved", "results": results}))


if __name__ == '__main__':
    if sys.argv[1] == "serve":
        for function, args in [(serve_tcp, (socket.AF_INET,)), (serve_tcp, (socket.AF_INET6,)), (serve_dns, ()), (serve_http, ())]:
            threading.Thread(target=function, args=args, daemon=True).start()
        threading.Event().wait()
    else:
        check()
