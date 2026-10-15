#!/usr/bin/env python3
"""socks5relay — stdlib-only credentialed-SOCKS5 relay.

Listens on 127.0.0.1 (no auth required from local clients, e.g. Chrome
--proxy-server=socks5://127.0.0.1:PORT) and forwards every CONNECT through an
upstream SOCKS5 proxy that requires username/password authentication.

Config: /etc/job-agent-runner/config.json -> proxy.socks5 = "socks5://user:pass@host:port"
"""
import json
import socket
import threading
import sys

LISTEN = ("127.0.0.1", 11080)
CONFIG = "/etc/job-agent-runner/config.json"


def upstream_from_config():
    with open(CONFIG) as f:
        cfg = json.load(f)
    raw = (cfg.get("proxy") or {}).get("socks5") or (cfg.get("proxy") or {}).get("http")
    if not raw:
        sys.exit("no proxy.socks5 in config")
    rest = raw.split("://", 1)[1]
    auth, hostport = rest.rsplit("@", 1) if "@" in rest else ("", rest)
    host, port = hostport.rsplit(":", 1)
    user, pwd = auth.split(":", 1) if ":" in auth else (auth, "")
    return host, int(port), user.encode(), pwd.encode()


UP = upstream_from_config()


def recvn(s, n):
    """Read exactly n bytes (recv() may short-read)."""
    buf = b""
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise OSError("connection closed")
        buf += chunk
    return buf


def socks5_connect(host, port):
    """Open a SOCKS5 connection to host:port through UP (auth from config)."""
    s = socket.create_connection((UP[0], UP[1]), timeout=30)
    s.settimeout(None)
    if UP[2]:
        s.sendall(b"\x05\x01\x02")  # offer user/pass auth only
        if recvn(s, 2)[1] != 0x02:
            s.close()
            raise OSError("upstream rejected user/pass auth")
        u, p = UP[2], UP[3]
        s.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
        if recvn(s, 2)[1] != 0x00:
            s.close()
            raise OSError("upstream auth failed")
    else:
        s.sendall(b"\x05\x01\x00")
        if recvn(s, 2)[1] != 0x00:
            s.close()
            raise OSError("upstream rejected no-auth")
    hb = host.encode()
    if len(hb) > 255:
        s.close()
        raise OSError("hostname too long")
    s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + int(port).to_bytes(2, "big"))
    resp = recvn(s, 4)
    if resp[3] == 0x01:
        recvn(s, 6)
    elif resp[3] == 0x03:
        recvn(s, recvn(s, 1)[0] + 2)
    elif resp[3] == 0x04:
        recvn(s, 18)
    if resp[1] != 0x00:
        s.close()
        raise OSError(f"upstream connect failed: {resp[:2].hex()}")
    return s


def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_WR)
            except OSError:
                pass


def handle(client):
    try:
        client.settimeout(30)
        # greeting: ver(1) + nmethods(1) + methods(n) — n is dynamic, never assume 1
        greeting = recvn(client, 2)
        if greeting[0] != 0x05:
            client.close()
            return
        recvn(client, greeting[1])
        client.sendall(b"\x05\x00")  # choose no-auth
        req = recvn(client, 4)
        if req[1] != 0x01:  # only CONNECT
            client.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            client.close()
            return
        atyp = req[3]
        if atyp == 0x03:
            host = recvn(client, recvn(client, 1)[0]).decode()
        elif atyp == 0x01:
            host = socket.inet_ntoa(recvn(client, 4))
        elif atyp == 0x04:
            host = socket.inet_ntop(socket.AF_INET6, recvn(client, 16))
        else:
            client.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            client.close()
            return
        port = int.from_bytes(recvn(client, 2), "big")
        try:
            upstream = socks5_connect(host, port)
        except OSError as e:
            print(f"upstream connect {host}:{port} failed: {e}", flush=True)
            client.sendall(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
            client.close()
            return
        client.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        client.settimeout(None)
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        pipe(upstream, client)
    except (OSError, IndexError, UnicodeDecodeError) as e:
        print(f"client error: {e!r}", flush=True)
        try:
            client.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(128)
    print(f"socks5relay on {LISTEN[0]}:{LISTEN[1]} -> {UP[0]}:{UP[1]} (auth={'yes' if UP[2] else 'no'})", flush=True)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()


if __name__ == "__main__":
    main()
