#!/usr/bin/env python3
"""Configure App Deck's trusted HTTPS origins."""

import json
import http.client
import shutil
import socket
import subprocess
import sys

from appdeck_server import _atomic_write_json, config_home, normalize_origin, public_origins


BACKEND = "http://127.0.0.1:8765"
TAILSOCK = "/run/tailscale/tailscaled.sock"


class LocalConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(TAILSOCK)


def local_request(method: str, data: dict | None = None, etag: str = "") -> tuple[int, str, bytes]:
    conn = LocalConnection("local-tailscaled.sock", timeout=10)
    headers = {"Host": "local-tailscaled.sock"}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers.update({"Content-Type": "application/json", "If-Match": etag})
    try:
        conn.request(method, "/localapi/v0/serve-config", body=body, headers=headers)
        response = conn.getresponse()
        payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise RuntimeError("Tailscale Serve configuration is too large.")
        return response.status, response.getheader("ETag", ""), payload
    except (OSError, http.client.HTTPException) as error:
        raise RuntimeError("Could not access the Tailscale service configuration.") from error
    finally:
        conn.close()


def save_origin(origin: str) -> str:
    origin = normalize_origin(origin)
    path = config_home() / "appdeck/connection.json"
    origins = public_origins() if path.exists() else []
    if origin not in origins:
        if len(origins) >= 2:
            raise RuntimeError("Two addresses are already configured. Remove one before adding another.")
        origins.append(origin)
        _atomic_write_json(path, {"origins": origins})
    return origin


def remove_origin(origin: str) -> None:
    origin = normalize_origin(origin)
    path = config_home() / "appdeck/connection.json"
    origins = public_origins()
    if origin not in origins:
        raise RuntimeError("The address is no longer configured.")
    origins.remove(origin)
    if origins:
        _atomic_write_json(path, {"origins": origins})
    else:
        path.unlink()


def tailscale_command(*args: str) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("tailscale")
    if not executable:
        raise RuntimeError("Tailscale is not installed. Install and connect it first.")
    try:
        return subprocess.run(
            [executable, *args], stdin=subprocess.DEVNULL, capture_output=True,
            text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Could not run Tailscale. Check that it is running.") from error


def tailscale_json(*args: str) -> dict:
    result = tailscale_command(*args)
    if result.returncode:
        raise RuntimeError("Could not inspect Tailscale. Check that it is running and accessible.")
    try:
        data = json.loads(result.stdout)
    except ValueError as error:
        raise RuntimeError("Tailscale returned an invalid status.") from error
    if not isinstance(data, dict):
        raise RuntimeError("Tailscale returned an invalid status.")
    return data


def tailscale_origin(allow_create: bool = True) -> str:
    status = tailscale_json("status", "--json")
    if status.get("BackendState") != "Running":
        raise RuntimeError("Connect Tailscale on this PC first.")
    self_status = status.get("Self")
    if not isinstance(self_status, dict):
        raise RuntimeError("Tailscale did not report this device.")
    name = self_status.get("DNSName")
    if not isinstance(name, str):
        raise RuntimeError("Enable MagicDNS for this Tailscale device.")
    name = name.rstrip(".").lower()
    origin = normalize_origin(f"https://{name}")
    if not name.endswith(".ts.net") or origin != f"https://{name}":
        raise RuntimeError("Tailscale returned an invalid HTTPS hostname.")
    domains = status.get("CertDomains")
    if not isinstance(domains, list) or name not in domains:
        raise RuntimeError("Enable HTTPS certificates in your Tailscale DNS settings first.")

    response, etag, body = local_request("GET")
    if response != 200 or not etag:
        raise RuntimeError("Could not read Tailscale Serve configuration safely.")
    try:
        routes = json.loads(body) or {}
    except ValueError as error:
        raise RuntimeError("Tailscale returned an invalid Serve configuration.") from error
    if not isinstance(routes, dict):
        raise RuntimeError("Tailscale returned an invalid Serve configuration.")
    tcp = routes.get("TCP", {})
    web = routes.get("Web", {})
    funnel = routes.get("AllowFunnel", {})
    foreground = routes.get("Foreground", {})
    if not all(isinstance(value, dict) for value in (tcp, web, funnel, foreground)):
        raise RuntimeError("Tailscale returned an invalid Serve configuration.")
    for hostport, config in web.items():
        if not isinstance(hostport, str) or not isinstance(config, dict):
            continue
        prefix = name + ":"
        if not hostport.startswith(prefix) or not hostport[len(prefix):].isdigit():
            continue
        port = int(hostport[len(prefix):])
        entry = tcp.get(str(port))
        handlers = config.get("Handlers")
        route = handlers.get("/") if isinstance(handlers, dict) else None
        if (
            1 <= port <= 65535
            and isinstance(entry, dict)
            and entry.get("HTTPS") is True
            and isinstance(route, dict)
            and route.get("Proxy") == BACKEND
            and not funnel.get(hostport)
        ):
            return f"https://{name}" + (f":{port}" if port != 443 else "")

    if not allow_create:
        raise RuntimeError("Two addresses are already configured. Remove one before adding another.")
    used = {str(port) for port in tcp}
    for config in foreground.values():
        if not isinstance(config, dict) or not all(
            isinstance(config.get(key, {}), dict) for key in ("TCP", "Web", "AllowFunnel")
        ):
            raise RuntimeError("Could not inspect foreground Tailscale routes safely.")
        used.update(map(str, config.get("TCP", {})))
        for key in ("Web", "AllowFunnel"):
            used.update(hostport.rpartition(":")[2] for hostport in config.get(key, {}) if isinstance(hostport, str))
    used.update(hostport.rpartition(":")[2] for hostport in funnel if isinstance(hostport, str))
    for port in range(8443, 8500):
        if str(port) in used or any(key.endswith(f":{port}") for key in web if isinstance(key, str)):
            continue
        with socket.socket() as sock:
            try:
                sock.bind(("0.0.0.0", port))
            except OSError:
                continue
        break
    else:
        raise RuntimeError("No unused Tailscale HTTPS port was found.")

    routes.setdefault("TCP", {})[str(port)] = {"HTTPS": True}
    routes.setdefault("Web", {})[f"{name}:{port}"] = {"Handlers": {"/": {"Proxy": BACKEND}}}
    response, _, _ = local_request("POST", routes, etag)
    if response == 412:
        raise RuntimeError("Tailscale configuration changed during setup. Please retry.")
    if response != 200:
        raise RuntimeError(
            f"Tailscale could not create the route. An administrator may need to run "
            f"'tailscale serve --bg --https={port} {BACKEND}', then retry."
        )
    return f"https://{name}:{port}"


def main() -> None:
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "tailscale":
            path = config_home() / "appdeck/connection.json"
            existing = public_origins() if path.exists() else []
            candidate = tailscale_origin(allow_create=len(existing) < 2)
            origin = save_origin(candidate)
            message = f"Tailscale configured: {origin}. Connect your phone to the tailnet."
        elif len(sys.argv) == 3 and sys.argv[1] == "add":
            origin = save_origin(sys.argv[2])
            message = f"Address added: {origin}. Verify that the phone trusts its certificate."
        elif len(sys.argv) == 3 and sys.argv[1] == "remove":
            remove_origin(sys.argv[2])
            message = "Address removed. The proxy route itself was not changed."
        else:
            raise RuntimeError("Invalid setup request.")
        print(json.dumps({"ok": True, "message": message}))
    except (RuntimeError, ValueError, OSError) as error:
        print(json.dumps({"ok": False, "message": str(error)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
