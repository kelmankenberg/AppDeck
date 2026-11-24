#!/usr/bin/env python3
"""Local-network App Deck service for launching selected desktop applications."""

from __future__ import annotations

import configparser
import hmac
import http.server
import ipaddress
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


PORT = 8765
PHONE_TIMEOUT_SECONDS = 45
PAIRING_ATTEMPTS = 5
PAIRING_WINDOW_SECONDS = 300
MAX_CONFIG_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 1024
APP_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,200}$")
FIELD_CODE_PATTERN = re.compile(r"%([A-Za-z%])")


def config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))


def state_home() -> Path:
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))


def desktop_dirs() -> list[Path]:
    data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    data_dirs = os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share").split(":")
    return [data_home / "applications"] + [
        Path(path) / "applications" for path in data_dirs if path
    ]


def parse_exec(exec_string: str, name: str, desktop_path: Path, icon: str = "") -> list[str]:
    """Parse a desktop Exec value without invoking a shell."""
    try:
        words = shlex.split(exec_string, posix=True)
    except ValueError as error:
        raise ValueError("Invalid desktop Exec value") from error

    argv: list[str] = []
    for word in words:
        if word in ("%f", "%F", "%u", "%U"):
            continue
        if word == "%i":
            if icon:
                argv.extend(["--icon", icon])
            continue

        def substitute(match: re.Match[str]) -> str:
            code = match.group(1)
            replacements = {
                "%": "%",
                "c": name,
                "k": str(desktop_path),
            }
            if code not in replacements:
                raise ValueError(f"Unsupported desktop field code %{code}")
            return replacements[code]

        argv.append(FIELD_CODE_PATTERN.sub(substitute, word))

    if not argv or not argv[0]:
        raise ValueError("Desktop entry has no launch command")
    return argv


def _read_desktop_entry(app_id: str, path: Path) -> dict[str, Any] | None:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str
    try:
        parser.read(path, encoding="utf-8")
        entry = parser["Desktop Entry"]
    except (OSError, KeyError, configparser.Error, UnicodeError):
        return None

    if entry.get("Type", "Application") != "Application":
        return None
    try:
        hidden = entry.getboolean("Hidden", fallback=False)
        no_display = entry.getboolean("NoDisplay", fallback=False)
        terminal = entry.getboolean("Terminal", fallback=False)
    except ValueError:
        return None
    if hidden or no_display or terminal:
        return None

    name = entry.get("Name", "").strip()
    exec_string = entry.get("Exec", "").strip()
    if not name or not exec_string:
        return None

    try:
        argv = parse_exec(exec_string, name, path, entry.get("Icon", ""))
    except ValueError:
        return None

    try_exec = entry.get("TryExec", "").strip()
    if try_exec and shutil.which(try_exec) is None and not Path(try_exec).is_file():
        return None
    executable = argv[0]
    if shutil.which(executable) is None and not Path(executable).is_file():
        return None

    return {"id": app_id, "name": name, "argv": argv, "icon": entry.get("Icon", "")}


def resolve_app_icons(apps: dict[str, dict[str, Any]]) -> tuple[dict[str, str], str]:
    icons = {app_id: app.get("icon", "") for app_id, app in apps.items() if app.get("icon")}
    if not icons:
        return {}, ""
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "icon_helper.py")],
            input=json.dumps(icons),
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        resolved = json.loads(result.stdout)
        if not isinstance(resolved, dict):
            raise ValueError("Invalid icon helper response")
        return resolved, ""
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}, "App icons are unavailable; showing placeholders."


def discover_apps() -> dict[str, dict[str, Any]]:
    apps: dict[str, dict[str, Any]] = {}
    for directory in desktop_dirs():
        if not directory.is_dir():
            continue
        for root, dirs, filenames in os.walk(directory, followlinks=False):
            dirs.sort()
            for filename in sorted(filenames):
                if not filename.endswith(".desktop"):
                    continue
                path = Path(root) / filename
                try:
                    relative = path.relative_to(directory)
                except ValueError:
                    continue
                app_id = str(relative).replace(os.sep, "-")
                if not APP_ID_PATTERN.fullmatch(app_id) or app_id in apps:
                    continue
                app = _read_desktop_entry(app_id, path)
                if app:
                    apps[app_id] = app
    return apps


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        if path.stat().st_size > MAX_CONFIG_BYTES:
            return fallback
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, ValueError, UnicodeError):
        return fallback


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".appdeck-", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as file:
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def _proc_start_time(pid: int) -> str | None:
    try:
        content = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        closing_paren = content.rfind(")")
        fields = content[closing_paren + 2 :].split()
        return fields[19]
    except (OSError, IndexError, ValueError):
        return None


class AppController:
    def __init__(self) -> None:
        self.config_path = config_home() / "appdeck/apps.json"
        self.runs_path = state_home() / "appdeck/runs.json"
        self.lock = threading.RLock()
        self.processes: dict[str, subprocess.Popen[bytes]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        self._load_runs()

    def selected_ids(self, catalog: dict[str, dict[str, Any]]) -> set[str]:
        data = _read_json(self.config_path, {})
        values = data.get("apps", []) if isinstance(data, dict) else []
        if not isinstance(values, list):
            return set()
        return {
            value
            for value in values
            if isinstance(value, str) and APP_ID_PATTERN.fullmatch(value) and value in catalog
        }

    def set_selected(self, app_id: str, enabled: bool, catalog: dict[str, dict[str, Any]]) -> None:
        if app_id not in catalog:
            raise KeyError("App is not installed")
        with self.lock:
            selected = self.selected_ids(catalog)
            if enabled:
                selected.add(app_id)
            else:
                selected.discard(app_id)
            _atomic_write_json(self.config_path, {"apps": sorted(selected)})

    def _load_runs(self) -> None:
        data = _read_json(self.runs_path, {})
        records = data.get("runs", []) if isinstance(data, dict) else []
        if not isinstance(records, list):
            return
        for item in records:
            if not isinstance(item, dict):
                continue
            app_id = item.get("id")
            pid = item.get("pid")
            started = item.get("startTime")
            if (
                isinstance(app_id, str)
                and APP_ID_PATTERN.fullmatch(app_id)
                and isinstance(pid, int)
                and pid > 1
                and isinstance(started, str)
                and _proc_start_time(pid) == started
            ):
                self.runs[app_id] = {"id": app_id, "pid": pid, "startTime": started}
        self._save_runs()

    def _save_runs(self) -> None:
        _atomic_write_json(self.runs_path, {"runs": list(self.runs.values())})

    def _is_running(self, app_id: str) -> bool:
        record = self.runs.get(app_id)
        if not record:
            return False
        pid = record["pid"]
        if _proc_start_time(pid) != record["startTime"]:
            self.runs.pop(app_id, None)
            self.processes.pop(app_id, None)
            self._save_runs()
            return False
        try:
            return os.getpgid(pid) == pid
        except ProcessLookupError:
            self.runs.pop(app_id, None)
            self.processes.pop(app_id, None)
            self._save_runs()
            return False

    def launch(self, app_id: str, catalog: dict[str, dict[str, Any]]) -> None:
        with self.lock:
            if app_id not in catalog:
                raise KeyError("App is not installed")
            if not self._is_running(app_id):
                app = catalog[app_id]
                try:
                    process = subprocess.Popen(
                        app["argv"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                except OSError as error:
                    raise RuntimeError("The app could not be started") from error

                started = None
                for _ in range(10):
                    started = _proc_start_time(process.pid)
                    if started is not None:
                        break
                    time.sleep(0.01)
                if started is None:
                    process.poll()
                    raise RuntimeError("The app exited before it could be tracked")
                self.processes[app_id] = process
                self.runs[app_id] = {
                    "id": app_id,
                    "pid": process.pid,
                    "startTime": started,
                }
                self._save_runs()

    def stop(self, app_id: str) -> None:
        with self.lock:
            if not self._is_running(app_id):
                return
            pid = self.runs[app_id]["pid"]
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                try:
                    os.killpg(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)

            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

            process = self.processes.pop(app_id, None)
            if process is not None:
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    pass
            self.runs.pop(app_id, None)
            self._save_runs()

    def state(self, app_id: str) -> str:
        return "running" if self._is_running(app_id) else "stopped"


def normalize_origin(origin: str) -> str:
    try:
        if not isinstance(origin, str) or origin != origin.strip():
            raise ValueError("invalid origin")
        parsed = urlsplit(origin)
        port = parsed.port
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or any(char.isspace() for char in parsed.netloc)
            or port == 0
        ):
            raise ValueError("invalid origin")
        host = parsed.hostname.lower()
        try:
            address = ipaddress.ip_address(host)
            host = f"[{address}]" if address.version == 6 else str(address)
        except ValueError:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host):
                raise ValueError("invalid hostname")
        return f"https://{host}" + (f":{port}" if port and port != 443 else "")
    except (ValueError, TypeError) as error:
        raise ValueError("Enter an HTTPS origin without a path, query, or credentials.") from error


def public_origins() -> list[str]:
    path = config_home() / "appdeck/connection.json"
    try:
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
        origins = data.get("origins", [data["origin"]] if "origin" in data else [])
        if not isinstance(origins, list) or not origins or len(origins) > 2:
            raise ValueError("Expected one or two HTTPS origins")
        normalized = [normalize_origin(origin) for origin in origins]
        if len(set(normalized)) != len(normalized):
            raise ValueError("Duplicate origins")
        return normalized
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise RuntimeError(
            "Configure a trusted HTTPS connection using the App Deck setup panel."
        ) from error


def public_origin() -> str:
    return public_origins()[0]


class AppDeckServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], token: str, controller: AppController, origin: str | list[str] | None = None) -> None:
        super().__init__(address, AppDeckHandler)
        self.token = token
        self.pairing_code = f"{secrets.randbelow(100_000_000):08d}"
        self.pairing_failures: list[float] = []
        self.pairing_lock = threading.Lock()
        self.controller = controller
        self.origins = [origin] if isinstance(origin, str) else origin or [
            f"http://{self.server_address[0]}:{self.server_address[1]}"
        ]
        self.origin = self.origins[0]
        self.failed_auth: dict[str, list[float]] = {}
        self.phone_lock = threading.Lock()
        self.phone_connected = False
        self.last_phone_activity: float | None = None

    def mark_phone_activity(self, now: float | None = None) -> None:
        with self.phone_lock:
            changed = not self.phone_connected
            self.phone_connected = True
            self.last_phone_activity = time.monotonic() if now is None else now
        if changed:
            self._emit_phone_status(True)

    def expire_phone_connection(self, now: float | None = None) -> bool:
        with self.phone_lock:
            current_time = time.monotonic() if now is None else now
            if (
                not self.phone_connected
                or self.last_phone_activity is None
                or current_time - self.last_phone_activity < PHONE_TIMEOUT_SECONDS
            ):
                return False
            self.phone_connected = False
            self.last_phone_activity = None
        self._emit_phone_status(False)
        return True

    @staticmethod
    def _emit_phone_status(connected: bool) -> None:
        print(
            json.dumps({"type": "phone-status", "connected": connected}),
            flush=True,
        )


class AppDeckHandler(http.server.BaseHTTPRequestHandler):
    server: AppDeckServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, value: Any) -> None:
        self._send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _host_is_valid(self) -> bool:
        host = self.headers.get("Host", "").lower()
        origin = self.headers.get("Origin")
        return any(
            host == urlsplit(allowed).netloc and (not origin or origin == allowed)
            for allowed in self.server.origins
        )

    def _authorized(self) -> bool:
        now = time.monotonic()
        address = self.client_address[0]
        recent = [stamp for stamp in self.server.failed_auth.get(address, []) if now - stamp < 60]
        if len(recent) >= 10:
            self.server.failed_auth[address] = recent
            return False

        supplied = self.headers.get("Authorization", "")
        valid = hmac.compare_digest(supplied, f"Bearer {self.server.token}")
        if not valid:
            recent.append(now)
        self.server.failed_auth[address] = recent
        return valid

    def _require_request(self) -> bool:
        if not self._host_is_valid():
            self._json(403, {"error": "Invalid host"})
            return False
        if not self._authorized():
            self._json(401, {"error": "Pairing code required"})
            return False
        self.server.mark_phone_activity()
        return True

    def _catalog(self) -> dict[str, dict[str, Any]]:
        return discover_apps()

    def do_GET(self) -> None:
        if not self._host_is_valid():
            self._json(403, {"error": "Invalid host"})
            return
        path = urlsplit(self.path).path
        if path == "/":
            self._send(200, (Path(__file__).parent / "web/index.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/app.js":
            self._send(200, (Path(__file__).parent / "web/app.js").read_bytes(), "text/javascript; charset=utf-8")
        elif path == "/style.css":
            self._send(200, (Path(__file__).parent / "web/style.css").read_bytes(), "text/css; charset=utf-8")
        elif path == "/api/apps":
            if not self._require_request():
                return
            catalog = self._catalog()
            selected = self.server.controller.selected_ids(catalog)
            icons, icon_error = resolve_app_icons({app_id: catalog[app_id] for app_id in selected})
            apps = [
                {
                    "id": app_id,
                    "name": app["name"],
                    "selected": app_id in selected,
                    "state": self.server.controller.state(app_id),
                    "icon": icons.get(app_id, ""),
                }
                for app_id, app in sorted(catalog.items(), key=lambda item: item[1]["name"].casefold())
            ]
            self._json(200, {"apps": apps, "iconError": icon_error})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/pair":
            self._pair()
            return
        if not self._require_request():
            return

        try:
            if path == "/api/ping":
                self._json(200, {"ok": True})
                return

            parts = path.split("/")
            if len(parts) != 5 or parts[1] != "api" or parts[2] != "apps":
                self._json(404, {"error": "Not found"})
                return

            app_id = unquote(parts[3])
            if not APP_ID_PATTERN.fullmatch(app_id):
                self._json(404, {"error": "App not found"})
                return

            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_REQUEST_BYTES:
                self._json(413, {"error": "Request too large"})
                return
            body = self.rfile.read(length) if length else b""

            catalog = self._catalog()
            if app_id not in catalog:
                self._json(404, {"error": "App not found"})
                return

            action = parts[4]
            if action == "favorite":
                try:
                    payload = json.loads(body or b"{}")
                except (ValueError, UnicodeError):
                    self._json(400, {"error": "Invalid request"})
                    return
                if not isinstance(payload, dict) or not isinstance(payload.get("enabled"), bool):
                    self._json(400, {"error": "Invalid request"})
                    return
                self.server.controller.set_selected(app_id, payload["enabled"], catalog)
                self._json(200, {"ok": True})
            elif action == "launch":
                if app_id not in self.server.controller.selected_ids(catalog):
                    self._json(403, {"error": "Configure this app before launching it"})
                    return
                self.server.controller.launch(app_id, catalog)
                self._json(200, {"ok": True})
            elif action == "stop":
                self.server.controller.stop(app_id)
                self._json(200, {"ok": True})
            else:
                self._json(404, {"error": "Not found"})
        except KeyError:
            self._json(404, {"error": "App not found"})
        except RuntimeError as error:
            self._json(422, {"error": str(error)})
        except (OSError, ValueError, json.JSONDecodeError):
            self._json(500, {"error": "App Deck could not complete the request"})

    def _pair(self) -> None:
        if (
            not self._host_is_valid()
            or self.headers.get("Origin") not in self.server.origins
            or self.headers.get_content_type() != "application/json"
        ):
            self.close_connection = True
            self._json(403, {"error": "Invalid pairing request"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.close_connection = True
            self._json(400, {"error": "Invalid pairing request"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            payload = None
        code = payload.get("code") if isinstance(payload, dict) else None
        valid_format = isinstance(code, str) and re.fullmatch(r"[0-9]{4}-?[0-9]{4}", code)
        normalized = code.replace("-", "") if valid_format else ""

        with self.server.pairing_lock:
            now = time.monotonic()
            self.server.pairing_failures = [
                stamp for stamp in self.server.pairing_failures
                if now - stamp < PAIRING_WINDOW_SECONDS
            ]
            if len(self.server.pairing_failures) >= PAIRING_ATTEMPTS:
                status, result = 429, {"error": "Too many pairing attempts. Try again in five minutes."}
            elif not hmac.compare_digest(normalized, self.server.pairing_code):
                self.server.pairing_failures.append(now)
                status, result = 401, {"error": "Incorrect pairing code"}
            else:
                status, result = 200, {"token": self.server.token}
        self._json(status, result)


def create_qr_file(url: str, runtime_dir: Path, index: int = 0) -> str:
    executable = shutil.which("qrencode")
    if not executable:
        return ""
    runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(runtime_dir, 0o700)
    qr_path = runtime_dir / ("pairing.png" if index == 0 else f"pairing-{index}.png")
    result = subprocess.run(
        [executable, "-o", str(qr_path), "-s", "6", "-m", "2"],
        input=url.encode("utf-8"),
        capture_output=True,
        timeout=5,
    )
    if result.returncode != 0:
        return ""
    os.chmod(qr_path, 0o600)
    return str(qr_path)


def main() -> int:
    origins = public_origins()
    token = secrets.token_urlsafe(24)
    controller = AppController()
    server = AppDeckServer(("127.0.0.1", PORT), token, controller, origins)

    runtime_base = Path(os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir()))
    runtime_dir = runtime_base / f"appdeck-{os.getuid()}"
    qr_files = [create_qr_file(f"{origin}/#{token}", runtime_dir, index) for index, origin in enumerate(origins)]

    print(
        json.dumps(
            {
                "urls": origins,
                "pairingCode": server.pairing_code[:4] + "-" + server.pairing_code[4:],
                "qrFiles": qr_files,
            }
        ),
        flush=True,
    )

    stop_monitor = threading.Event()
    monitor = threading.Thread(
        target=lambda: _monitor_phone(server, stop_monitor),
        daemon=True,
    )
    monitor.start()
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        stop_monitor.set()
        server.server_close()
        for qr_file in qr_files:
            if qr_file:
                Path(qr_file).unlink(missing_ok=True)
        try:
            runtime_dir.rmdir()
        except OSError:
            pass
    return 0


def _monitor_phone(server: AppDeckServer, stop: threading.Event) -> None:
    while not stop.wait(5):
        server.expire_phone_connection()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"App Deck: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
