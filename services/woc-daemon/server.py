#!/usr/bin/env python3
"""Authenticated, local-only wx-cli adapter. No GUI, key scans or consumer state."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TYPES = {"text", "image", "voice", "video", "sticker", "location", "link", "file", "call", "system"}
KINDS = {"image", "img", "video", "file", "sticker", "voice"}
SCHEMA = {
    "sessions": {"limit"}, "unread": {"limit", "filter"},
    "contacts": {"query", "limit"}, "groups": {"query", "limit"},
    "members": {"chat"},
    "history": {"chat", "limit", "offset", "since", "until", "type"},
    "search": {"keyword", "chats", "limit", "since", "until", "type"},
    "attachments": {"chat", "kinds", "limit", "offset", "since", "until"},
    "extract": {"attachment_id"}, "health": set(), "revision": set(),
}


class Failure(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def arguments(operation, body):
    if operation not in SCHEMA or not isinstance(body, dict) or body.keys() - SCHEMA[operation]:
        raise Failure("WOC_INVALID_ARGUMENT", "Unknown operation or argument")
    args = [operation, "--json"]
    for key in ("chat", "keyword", "attachment_id"):
        if key in SCHEMA[operation]:
            value = body.get(key)
            if not isinstance(value, str) or not value or len(value) > 8192 or "\0" in value or value.startswith("-"):
                raise Failure("WOC_INVALID_ARGUMENT", f"Invalid {key}")
            args.append(value)
    for key, value in body.items():
        if key in {"chat", "keyword", "attachment_id"}:
            continue
        if key in {"limit", "offset"}:
            lo, hi = (1, 500) if key == "limit" else (0, 100000)
            if type(value) is not int or not lo <= value <= hi:
                raise Failure("WOC_INVALID_ARGUMENT", f"{key} outside supported range")
        elif key in {"since", "until"}:
            if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise Failure("WOC_INVALID_ARGUMENT", "Dates must be YYYY-MM-DD")
        elif key == "type":
            if value not in TYPES:
                raise Failure("WOC_INVALID_ARGUMENT", "Unknown message type")
        elif key == "query":
            if not isinstance(value, str) or len(value) > 256 or "\0" in value:
                raise Failure("WOC_INVALID_ARGUMENT", "Invalid query")
        elif key in {"filter", "kinds", "chats"}:
            if not isinstance(value, list) or len(value) > 20 or not all(isinstance(x, str) and 0 < len(x) <= 256 and "\0" not in x for x in value):
                raise Failure("WOC_INVALID_ARGUMENT", "Invalid list")
            allowed = KINDS if key == "kinds" else {"all", "private", "group", "official", "folded"}
            if key != "chats" and not set(value) <= allowed:
                raise Failure("WOC_INVALID_ARGUMENT", "Invalid list entry")
            flag = {"filter": "--filter", "kinds": "--kind", "chats": "--in"}[key]
            args.extend(f"{flag}={x}" for x in value)
            continue
        args.append(f"--{key}={value}")
    if operation in {"sessions", "unread", "history", "search", "attachments"}:
        args.insert(0, "--with-meta")
    return args


def unread_flags(value):
    if isinstance(value, dict):
        result = {k: unread_flags(v) for k, v in value.items()}
        if type(value.get("unread")) is int:
            result["has_unread"] = value["unread"] > 0
        return result
    if isinstance(value, list):
        return [unread_flags(v) for v in value]
    return value


class Service:
    def __init__(self, binary, home, token_file, exports, timeout=90, ttl=3600, max_export=256 * 1024 * 1024):
        self.binary, self.home = str(binary), Path(home)
        self.token_file, self.exports = Path(token_file), Path(exports)
        self.timeout, self.ttl, self.max_export = timeout, ttl, max_export
        self.gate = threading.BoundedSemaphore(1)
        self.exports.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.files = {}
        self.files_lock = threading.Lock()
        # Export handles are ephemeral. Restart invalidates and removes owned exports.
        for p in self.exports.iterdir():
            if re.fullmatch(r"[a-f0-9]{48}", p.name) and p.is_file() and not p.is_symlink():
                p.unlink()

    def authenticate(self, headers):
        try:
            token = self.token_file.read_text().strip()
        except OSError:
            raise Failure("WOC_NOT_CONFIGURED", "Service credential unavailable", 503)
        supplied = headers.get("Authorization", "")
        if len(token) < 32 or not hmac.compare_digest(supplied.encode(), ("Bearer " + token).encode()):
            raise Failure("WOC_UNAUTHORIZED", "Invalid service credential", 401)
        principal = headers.get("X-WOC-Principal", "")
        if not re.fullmatch(r"[a-f0-9]{64}", principal):
            raise Failure("WOC_UNAUTHORIZED", "Authenticated caller identity required", 401)
        return principal

    def config(self):
        try:
            value = json.loads((self.home / "config.json").read_text())
            db = Path(value["db_dir"])
            key = Path(value["keys_file"])
            if not key.is_absolute():
                key = self.home / key
            if not db.is_absolute() or not db.is_dir() or not key.is_file() or not os.access(self.binary, os.X_OK):
                raise ValueError()
            return db.resolve()
        except (OSError, ValueError, KeyError):
            raise Failure("WOC_NOT_CONFIGURED", "wx-cli account configuration is unavailable", 503)

    def revision(self):
        db = self.config()
        rows = []
        for p in sorted(db.rglob("*.db")):
            if p.is_symlink() or p.resolve() != p.absolute():
                raise Failure("WOC_SOURCE_UNAVAILABLE", "Unsafe database path", 503)
            s = p.stat()
            rows.append([str(p.relative_to(db)), s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns])
            if len(rows) > 4096:
                raise Failure("WOC_SOURCE_UNAVAILABLE", "Too many databases", 503)
        return {"revision": hashlib.sha256(json.dumps(rows).encode()).hexdigest(),
                "source": "database_files", "freshness": "checkpoint_only"}

    def run_cli(self, args):
        env = dict(os.environ, WX_CLI_HOME=str(self.home))
        # Neither credentials nor message bodies are logged; stderr remains private.
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                proc = subprocess.run([self.binary, *args], env=env, cwd=self.home,
                                      stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                raise Failure("WOC_QUERY_TIMEOUT", "wx-cli query timed out; no GUI operation was performed", 504)
            if proc.returncode:
                raise Failure("WOC_QUERY_FAILED", "wx-cli query failed; check account, key coverage and arguments", 502)
            stdout.seek(0)
            raw = stdout.read(16 * 1024 * 1024 + 1)
            if len(raw) > 16 * 1024 * 1024:
                raise Failure("WOC_RESULT_TOO_LARGE", "Reduce the query limit", 413)
            try:
                return json.loads(raw)
            except ValueError:
                raise Failure("WOC_INVALID_UPSTREAM", "wx-cli did not return JSON", 502)

    def cleanup(self):
        with self.files_lock:
            for key, value in list(self.files.items()):
                if value["expires"] <= time.time():
                    value["path"].unlink(missing_ok=True)
                    del self.files[key]

    def execute(self, op, body, principal):
        args = arguments(op, body)
        self.config()
        if op == "health":
            return {"ready": True, "version": 1, "capabilities": list(SCHEMA), "gui_writes": False}
        if op == "revision":
            return self.revision()
        if not self.gate.acquire(blocking=False):
            raise Failure("WOC_QUERY_BUSY", "A local query is running; retry later", 429)
        try:
            self.cleanup()
            if op != "extract":
                return unread_flags(self.run_cli(args))
            with self.files_lock:
                if len(self.files) >= 32:
                    raise Failure("WOC_EXPORT_LIMIT", "Export retention limit reached", 429)
            handle = secrets.token_hex(24)
            path = self.exports / handle
            try:
                result = self.run_cli([*args, "--output=" + str(path)])
                if result.get("exported") is not True:
                    path.unlink(missing_ok=True)
                    return result
                s = path.lstat()
                if not stat.S_ISREG(s.st_mode) or s.st_size > self.max_export:
                    raise Failure("WOC_EXPORT_LIMIT", "Export exceeds local size limit", 413)
                path.chmod(0o600)
                expiry = time.time() + self.ttl
                with self.files_lock:
                    self.files[handle] = {"path": path, "owner": principal, "expires": expiry}
                result.pop("output", None)
                result.update(file_id=handle, output_size=s.st_size, expires_at=int(expiry))
                return result
            except Exception:
                path.unlink(missing_ok=True)
                raise
        finally:
            self.gate.release()

    def download(self, handle, principal):
        self.cleanup()
        with self.files_lock:
            record = self.files.get(handle)
            if not record or record["owner"] != principal:
                raise Failure("WOC_FILE_NOT_FOUND", "Export unavailable or expired", 404)
            fd = os.open(record["path"], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            return os.fdopen(fd, "rb")


def make_server(service, host="127.0.0.1", port=0):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def json(self, status, body):
            raw = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def dispatch(self):
            try:
                principal = service.authenticate(self.headers)
                if self.command == "GET" and re.fullmatch(r"/v1/files/[a-f0-9]{48}", self.path):
                    with service.download(self.path.rsplit("/", 1)[1], principal) as f:
                        self.send_response(200)
                        self.send_header("Content-Type", "application/octet-stream")
                        self.send_header("Content-Disposition", 'attachment; filename="wechat-export"')
                        self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        while chunk := f.read(65536):
                            self.wfile.write(chunk)
                    return
                if self.command != "POST" or not re.fullmatch(r"/v1/[a-z]+", self.path):
                    raise Failure("WOC_NOT_FOUND", "Unknown route", 404)
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 65536 or self.headers.get("Transfer-Encoding"):
                    raise Failure("WOC_INVALID_ARGUMENT", "Invalid request body size", 413)
                body = json.loads(self.rfile.read(size))
                self.json(200, service.execute(self.path[4:], body, principal))
            except Failure as e:
                self.json(e.status, {"code": e.code, "error": e.message})
            except (ValueError, TypeError):
                self.json(400, {"code": "WOC_INVALID_ARGUMENT", "error": "Invalid JSON or argument"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.json(503, {"code": "WOC_SERVICE_UNAVAILABLE", "error": "Local data service unavailable"})

        do_GET = dispatch
        do_POST = dispatch
    class Server(ThreadingHTTPServer):
        last_cleanup = 0

        def service_actions(self):
            if time.monotonic() - self.last_cleanup > 30:
                self.last_cleanup = time.monotonic()
                try:
                    service.cleanup()
                except OSError:
                    pass
    return Server((host, port), Handler)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    service = Service(config["binary"], config["wx_home"], config["token_file"], config["exports"],
                      timeout=config.get("timeout_seconds", 90), ttl=config.get("export_ttl_seconds", 3600))
    server = make_server(service, config.get("host", "127.0.0.1"), config.get("port", 3212))
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({"service": "woc-daemon", "state": "listening", "port": server.server_port}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
