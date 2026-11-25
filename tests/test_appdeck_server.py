import unittest
import json
import tempfile
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO
from threading import Thread
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

from appdeck_server import AppController, AppDeckServer, DeviceStore, focus_workspace, parse_exec, public_origin, public_origins, workspace_snapshot
import connection_setup
from appearance import DesktopAppearance


class AppearanceTests(unittest.TestCase):
    def test_palette_validation_and_wallpaper_revision_follow_current_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "state/omarchy/current"
            (current / "theme").mkdir(parents=True)
            palette = current / "theme/colors.toml"
            palette.write_text('background = "#101010"\nforeground = "#eeeeee"\naccent = "#e6b450"\n')
            background = root / "first.webp"
            background.write_bytes(b"test image")
            (current / "background").symlink_to(background)
            appearance = DesktopAppearance(root / "state", root / "config")
            first = appearance.snapshot()
            self.assertEqual(first["colors"]["accent"], "#e6b450")
            self.assertEqual(first["colorError"], "")
            self.assertNotIn(str(root), json.dumps(first))
            background.write_bytes(b"changed image")
            self.assertNotEqual(first["wallpaper"], appearance.snapshot()["wallpaper"])
            palette.write_text('background = "url(https://example.invalid/track)"\n')
            self.assertIsNone(appearance.snapshot()["colors"])
            self.assertTrue(appearance.snapshot()["colorError"])
            (current / "background").unlink()
            self.assertIsNone(appearance.snapshot()["wallpaper"])
            self.assertTrue(appearance.snapshot()["wallpaperError"])

    def test_wallpaper_conversion_is_cached_and_errors_are_explicit(self):
        import subprocess

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "state/omarchy/current"
            current.mkdir(parents=True)
            image = root / "image.png"
            image.write_bytes(b"image")
            (current / "background").symlink_to(image)
            appearance = DesktopAppearance(root / "state", root / "config")
            with patch("appearance.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"\xff\xd8jpeg")) as convert:
                self.assertEqual(appearance.wallpaper(), b"\xff\xd8jpeg")
                appearance.wallpaper()
                self.assertEqual(convert.call_count, 1)
                self.assertEqual(convert.call_args.args[0][-1], str(image))
                image.write_bytes(b"new image")
                appearance.wallpaper()
                self.assertEqual(convert.call_count, 2)
            image.write_bytes(b"another image")
            with patch("appearance.subprocess.run", return_value=subprocess.CompletedProcess([], 1, b"", b"error")):
                with self.assertRaisesRegex(RuntimeError, "GdkPixbuf"):
                    appearance.wallpaper()

    def test_appearance_routes_require_pairing_and_never_accept_a_file_path(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), redirect_stdout(StringIO()):
            server = AppDeckServer(("127.0.0.1", 0), "bootstrap", AppController())
            token = server.devices.pair("Phone")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                for path in ("/api/appearance", "/api/wallpaper"):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + path, timeout=2)
                    self.assertEqual(error.exception.code, 401)
                    error.exception.close()
                headers = {"Authorization": f"Bearer {token}"}
                with urlopen(Request(base + "/api/appearance", headers=headers), timeout=2) as response:
                    self.assertTrue(json.load(response)["colorError"])
                with patch.object(server.appearance, "wallpaper", return_value=b"\xff\xd8jpeg") as wallpaper:
                    with urlopen(Request(base + "/api/wallpaper?path=/etc/passwd", headers=headers), timeout=2) as response:
                        self.assertEqual(response.headers.get_content_type(), "image/jpeg")
                        self.assertEqual(response.read(), b"\xff\xd8jpeg")
                    wallpaper.assert_called_once_with()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


class DeviceStoreTests(unittest.TestCase):
    def test_device_credentials_persist_and_revoke_independently(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.state_home", return_value=Path(temporary)
        ):
            store = DeviceStore()
            first = store.pair("<img src=https://example.invalid/>")
            second = store.pair("Second phone")
            devices = store.list()
            self.assertNotEqual(first, second)
            self.assertNotIn(first, store.path.read_text())
            self.assertNotIn("hash", devices[0])
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)
            reloaded = DeviceStore()
            reloaded.update(devices[0]["id"], "Renamed phone")
            self.assertEqual(store.list()[0]["name"], "Renamed phone")
            self.assertTrue(reloaded.authorize(first))
            reloaded.update(devices[0]["id"])
            self.assertFalse(store.authorize(first))
            self.assertTrue(store.authorize(second))
            reloaded.revoke_all()
            self.assertFalse(store.authorize(second))
            self.assertEqual(store.list(), [])

    def test_concurrent_pairing_preserves_all_devices_and_enforces_limits(self):
        from concurrent.futures import ThreadPoolExecutor

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.state_home", return_value=Path(temporary)
        ):
            store = DeviceStore()
            with ThreadPoolExecutor(max_workers=8) as pool:
                tokens = list(pool.map(lambda number: DeviceStore().pair(f"Phone {number}"), range(32)))
            self.assertEqual(len(store.list()), 32)
            self.assertEqual(len(set(tokens)), 32)
            with self.assertRaisesRegex(RuntimeError, "limit"):
                store.pair("Too many")
            store.revoke_all()
            for name in ("", "x" * 65, "bad\nname", 4):
                with self.assertRaises(RuntimeError):
                    store.pair(name)
            store.path.write_text("invalid json")
            with self.assertRaises(RuntimeError):
                store.authorize(tokens[0])

    def test_legacy_pairing_secret_is_rotated_on_upgrade(self):
        from appdeck_server import pairing_token

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.state_home", return_value=Path(temporary)
        ):
            old = pairing_token()
            path = Path(temporary) / "appdeck/pairing.json"
            path.write_text(json.dumps({"token": old}))
            new = pairing_token()
            self.assertNotEqual(old, new)
            self.assertEqual(pairing_token(), new)

    def test_qr_exchange_and_live_revocation_do_not_expose_device_controls(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), redirect_stdout(StringIO()):
            secret = "s" * 32
            server = AppDeckServer(("127.0.0.1", 0), secret, AppController())
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"

            def ping(token):
                return urlopen(Request(base + "/api/ping", data=b"", headers={
                    "Authorization": f"Bearer {token}"
                }), timeout=2)

            try:
                tokens = []
                for name in ("First", "Second"):
                    with urlopen(Request(base + "/api/pair", data=json.dumps({
                        "secret": secret, "name": name,
                    }).encode(), headers={"Content-Type": "application/json", "Origin": base}), timeout=2) as response:
                        tokens.append(json.load(response)["token"])
                with self.assertRaises(HTTPError) as error:
                    ping(secret)
                self.assertEqual(error.exception.code, 401)
                error.exception.close()
                for token in tokens:
                    with ping(token) as response:
                        self.assertEqual(response.status, 200)
                DeviceStore().update(server.devices.list()[0]["id"])
                with self.assertRaises(HTTPError) as error:
                    ping(tokens[0])
                self.assertEqual(error.exception.code, 401)
                error.exception.close()
                with ping(tokens[1]) as response:
                    self.assertEqual(response.status, 200)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/api/devices", headers={
                        "Authorization": f"Bearer {tokens[1]}"
                    }), timeout=2)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


class WebInstallTests(unittest.TestCase):
    def test_manifest_and_icons_are_served_without_pairing(self):
        import struct

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), redirect_stdout(StringIO()):
            server = AppDeckServer(("127.0.0.1", 0), "test-token", AppController())
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/app.webmanifest", timeout=2) as response:
                    self.assertEqual(response.headers.get_content_type(), "application/manifest+json")
                    manifest = json.load(response)
                self.assertEqual(manifest["id"], "/")
                self.assertEqual(manifest["start_url"], "/")
                self.assertEqual(manifest["display"], "standalone")
                for icon in manifest["icons"]:
                    with urlopen(base + icon["src"], timeout=2) as response:
                        self.assertEqual(response.headers.get_content_type(), "image/png")
                        header = response.read(24)
                    self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
                    width, height = struct.unpack(">II", header[16:24])
                    self.assertEqual(f"{width}x{height}", icon["sizes"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


class WorkspaceTests(unittest.TestCase):
    def test_snapshot_matches_focused_monitor_block_and_guests(self):
        monitors = [
            {"name": "DP-1", "focused": False, "activeWorkspace": {"id": 1}},
            {"name": "HDMI-A-1", "focused": True, "activeWorkspace": {"id": 21}},
        ]
        workspaces = [
            {"id": 18, "monitor": "DP-1", "windows": 1},
            {"id": 20, "monitor": "HDMI-A-1", "windows": 1},
            {"id": 21, "monitor": "HDMI-A-1", "windows": 2},
            {"id": 29, "monitor": "HDMI-A-1", "windows": 0},
            {"id": 30, "monitor": "DP-1", "windows": 1},
            {"id": 31, "monitor": "DP-1", "windows": 1},
            {"id": None, "monitor": "HDMI-A-1", "windows": 1},
        ]
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.state_home", return_value=Path(temporary)
        ), patch("appdeck_server.hyprctl", side_effect=[json.dumps(monitors), json.dumps(workspaces)]):
            mapping = Path(temporary) / "omarchy/monitors/workspaces"
            mapping.parent.mkdir(parents=True)
            mapping.write_text("0\tDP-1\tinfo\n2\tHDMI-A-1\tinfo\n")
            snapshot = workspace_snapshot()
        self.assertEqual(snapshot["active"], 21)
        self.assertEqual(snapshot["block"], 2)
        self.assertEqual([item["id"] for item in snapshot["workspaces"]], [21, 22, 23, 24, 25, 29, 30, 20])
        self.assertEqual([item["label"] for item in snapshot["workspaces"]], [1, 2, 3, 4, 5, 9, 0, 0])
        self.assertTrue(snapshot["workspaces"][0]["occupied"])

    def test_snapshot_falls_back_to_active_block_and_rejects_bad_data(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.state_home", return_value=Path(temporary)
        ):
            focused = [{"name": "DP-1", "focused": True, "activeWorkspace": {"id": 14}}]
            with patch("appdeck_server.hyprctl", side_effect=[json.dumps(focused), "[]"]):
                self.assertEqual([w["id"] for w in workspace_snapshot()["workspaces"]], [11, 12, 13, 14, 15])
            for monitors in ("not json", "[]", json.dumps([{
                "name": 'DP-1"); bad()', "focused": True, "activeWorkspace": {"id": 1}
            }])):
                with patch("appdeck_server.hyprctl", side_effect=[monitors, "[]"]):
                    with self.assertRaises(RuntimeError):
                        workspace_snapshot()

    def test_focus_uses_validated_dispatch_and_rejects_missing_workspace(self):
        snapshot = {
            "monitor": "DP-1", "block": 1, "active": 11,
            "workspaces": [{"id": 12}, {"id": 30}],
        }
        with patch("appdeck_server.workspace_snapshot", return_value=snapshot), patch(
            "appdeck_server.hyprctl", return_value="ok\n"
        ) as command:
            focus_workspace(12)
            command.assert_called_with("dispatch", 'o.workspaces.focus(2, "DP-1")')
            focus_workspace(30)
            command.assert_called_with("dispatch", 'hl.dsp.focus({ workspace = "30" })')
            with self.assertRaises(RuntimeError):
                focus_workspace(13)
            self.assertEqual(command.call_count, 2)
            command.return_value = "error"
            with self.assertRaises(RuntimeError):
                focus_workspace(12)

    def test_workspace_api_requires_auth_and_refreshes_cache_after_focus(self):
        snapshot = {"monitor": "DP-1", "block": 0, "active": 1, "workspaces": [{"id": 1, "label": 1}]}
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), patch(
            "appdeck_server.workspace_snapshot", return_value=snapshot
        ) as get_snapshot, patch("appdeck_server.hyprctl", return_value="ok") as dispatch, redirect_stdout(StringIO()):
            server = AppDeckServer(("127.0.0.1", 0), "test-token", AppController())
            device_token = server.devices.pair("Test phone")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                for path, data in [("/api/workspaces", None), ("/api/workspaces/1/focus", b"")]:
                    with self.assertRaises(HTTPError) as error:
                        urlopen(Request(base + path, data=data), timeout=2)
                    self.assertEqual(error.exception.code, 401)
                    error.exception.close()
                headers = {"Authorization": f"Bearer {device_token}"}
                for _ in range(2):
                    with urlopen(Request(base + "/api/workspaces", headers=headers), timeout=2) as response:
                        self.assertEqual(json.load(response)["active"], 1)
                self.assertEqual(get_snapshot.call_count, 1)
                with urlopen(Request(base + "/api/workspaces/1/focus", data=b"", headers=headers), timeout=2):
                    pass
                dispatch.assert_called_once_with("dispatch", 'o.workspaces.focus(1, "DP-1")')
                with urlopen(Request(base + "/api/workspaces", headers=headers), timeout=2):
                    pass
                self.assertEqual(get_snapshot.call_count, 3)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/api/workspaces/2/focus", data=b"", headers=headers), timeout=2)
                self.assertEqual(error.exception.code, 422)
                error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


class ParseExecTests(unittest.TestCase):
    def test_https_origin_configuration(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary)
        ):
            path = Path(temporary) / "appdeck/connection.json"
            path.parent.mkdir()
            for value, expected in [
                ("https://deck.example:8443", "https://deck.example:8443"),
                ("https://DECK.example:443/", "https://deck.example"),
                ("https://192.168.1.2:8443", "https://192.168.1.2:8443"),
            ]:
                path.write_text(json.dumps({"origin": value}))
                self.assertEqual(public_origin(), expected)
            for value in [
                "http://deck.example", "https://user@deck.example",
                "https://deck.example/path", "https://deck.example?x=1",
                "https://deck.example:0", "https://deck.example:99999",
            ]:
                path.write_text(json.dumps({"origin": value}))
                with self.assertRaises(RuntimeError, msg=value):
                    public_origin()

    def test_reverse_proxy_requires_configured_https_host_and_origin(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), redirect_stdout(StringIO()):
            origin = "https://deck.example:8443"
            server = AppDeckServer(("127.0.0.1", 0), "test-token", AppController(), origin)
            device_token = server.devices.pair("Test phone")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/api/ping"
            try:
                for headers, status in [
                    ({"Host": "deck.example:8443", "Origin": origin, "Authorization": f"Bearer {device_token}"}, 200),
                    ({"Host": "wrong.example:8443", "Origin": origin, "Authorization": f"Bearer {device_token}"}, 403),
                    ({"Host": "deck.example:8443", "Origin": "http://deck.example:8443", "Authorization": f"Bearer {device_token}"}, 403),
                ]:
                    request = Request(url, data=b"", headers=headers, method="POST")
                    try:
                        with urlopen(request, timeout=2) as response:
                            self.assertEqual(response.status, status)
                    except HTTPError as error:
                        self.assertEqual(error.code, status)
                        error.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_multiple_origins_require_matching_host_and_origin(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), redirect_stdout(StringIO()):
            origins = ["https://first.example", "https://second.example:8443"]
            server = AppDeckServer(("127.0.0.1", 0), "test-token", AppController(), origins)
            device_token = server.devices.pair("Test phone")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/api/ping"
            try:
                for host, origin, status in [
                    ("first.example", origins[0], 200),
                    ("second.example:8443", origins[1], 200),
                    ("first.example", origins[1], 403),
                    ("other.example", origins[0], 403),
                ]:
                    request = Request(url, data=b"", headers={
                        "Host": host, "Origin": origin, "Authorization": f"Bearer {device_token}"
                    }, method="POST")
                    try:
                        with urlopen(request, timeout=2) as response:
                            self.assertEqual(response.status, status)
                    except HTTPError as error:
                        self.assertEqual(error.code, status)
                        error.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_setup_preserves_legacy_origin_and_removes_only_selected(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary)
        ), patch("connection_setup.config_home", return_value=Path(temporary)):
            path = Path(temporary) / "appdeck/connection.json"
            path.parent.mkdir()
            path.write_text(json.dumps({"origin": "https://first.example"}))
            connection_setup.save_origin("https://second.example:8443")
            self.assertEqual(public_origins(), ["https://first.example", "https://second.example:8443"])
            with self.assertRaises(RuntimeError):
                connection_setup.save_origin("https://third.example")
            connection_setup.remove_origin("https://first.example")
            self.assertEqual(public_origins(), ["https://second.example:8443"])
            connection_setup.remove_origin("https://second.example:8443")
            self.assertFalse(path.exists())

    def test_tailscale_setup_preserves_routes_and_uses_conditional_write(self):
        import json
        from unittest.mock import Mock

        status = {"BackendState": "Running", "Self": {"DNSName": "pc.tail123.ts.net."},
                  "CertDomains": ["pc.tail123.ts.net"]}
        routes = {"TCP": {"8443": {"HTTPS": True}},
                  "Web": {"pc.tail123.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}}}}
        with patch("connection_setup.tailscale_json", return_value=status), patch(
            "connection_setup.local_request",
            side_effect=[(200, "snapshot", json.dumps(routes).encode()), (200, "", b"")],
        ) as local, patch("connection_setup.socket.socket") as sock:
            sock.return_value.__enter__.return_value = Mock()
            self.assertEqual(connection_setup.tailscale_origin(), "https://pc.tail123.ts.net:8444")
            method, written, etag = local.call_args.args
            self.assertEqual((method, etag), ("POST", "snapshot"))
            self.assertEqual(written["Web"]["pc.tail123.ts.net:8443"], routes["Web"]["pc.tail123.ts.net:8443"])
            self.assertEqual(written["Web"]["pc.tail123.ts.net:8444"]["Handlers"]["/"]["Proxy"], connection_setup.BACKEND)

    def test_tailscale_reuses_private_route_and_rejects_stale_update(self):
        import json
        from unittest.mock import Mock

        status = {"BackendState": "Running", "Self": {"DNSName": "pc.tail123.ts.net."},
                  "CertDomains": ["pc.tail123.ts.net"]}
        route = {"TCP": {"8443": {"HTTPS": True}},
                 "Web": {"pc.tail123.ts.net:8443": {"Handlers": {"/": {"Proxy": connection_setup.BACKEND}}}}}
        with patch("connection_setup.tailscale_json", return_value=status), patch(
            "connection_setup.local_request", return_value=(200, "etag", json.dumps(route).encode())
        ) as local:
            self.assertEqual(connection_setup.tailscale_origin(False), "https://pc.tail123.ts.net:8443")
            self.assertEqual(local.call_count, 1)
        route["AllowFunnel"] = {"pc.tail123.ts.net:8443": True}
        with patch("connection_setup.tailscale_json", return_value=status), patch(
            "connection_setup.local_request", return_value=(200, "etag", json.dumps(route).encode())
        ) as local:
            with self.assertRaisesRegex(RuntimeError, "Two addresses"):
                connection_setup.tailscale_origin(False)
            self.assertEqual(local.call_count, 1)
        with patch("connection_setup.tailscale_json", return_value=status), patch(
            "connection_setup.local_request", side_effect=[(200, "etag", b"{}"), (412, "", b"")]
        ), patch("connection_setup.socket.socket") as sock:
            sock.return_value.__enter__.return_value = Mock()
            with self.assertRaisesRegex(RuntimeError, "changed"):
                connection_setup.tailscale_origin()

    def test_expands_supported_fields_without_shell_interpretation(self):
        desktop_file = Path("/usr/share/applications/sample.desktop")
        argv = parse_exec(
            'sample --title "%c" --desktop "%k" %U',
            "Sample App",
            desktop_file,
        )
        self.assertEqual(
            argv,
            [
                "sample",
                "--title",
                "Sample App",
                "--desktop",
                "/usr/share/applications/sample.desktop",
            ],
        )

    def test_icon_field_expands_to_option_and_value(self):
        argv = parse_exec("sample %i", "Sample", Path("/tmp/sample.desktop"), "sample-icon")
        self.assertEqual(argv, ["sample", "--icon", "sample-icon"])

    def test_unsupported_field_code_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_exec("sample %Z", "Sample", Path("/tmp/sample.desktop"))

    def test_empty_command_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_exec("", "Sample", Path("/tmp/sample.desktop"))

    def test_controller_tracks_and_stops_its_own_process_group(self):
        import sys
        import tempfile
        import time

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("appdeck_server.config_home", return_value=root / "config"), patch(
                "appdeck_server.state_home", return_value=root / "state"
            ):
                controller = AppController()
                catalog = {
                    "sample.desktop": {
                        "id": "sample.desktop",
                        "name": "Sample",
                        "argv": [sys.executable, "-c", "import time; time.sleep(30)"],
                    }
                }
                controller.launch("sample.desktop", catalog)
                self.assertEqual(controller.state("sample.desktop"), "running")
                controller.stop("sample.desktop")
                time.sleep(0.05)
                self.assertEqual(controller.state("sample.desktop"), "stopped")

    def test_mobile_api_can_configure_an_installed_app(self):
        import json
        import tempfile

        catalog = {
            "sample.desktop": {
                "id": "sample.desktop",
                "name": "Sample",
                "argv": ["/bin/true"],
            }
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("appdeck_server.config_home", return_value=root / "config"), patch(
                "appdeck_server.state_home", return_value=root / "state"
            ), patch("appdeck_server.discover_apps", return_value=catalog), patch(
                "appdeck_server.resolve_app_icons",
                return_value=({"sample.desktop": "data:image/png;base64,dGVzdA=="}, ""),
            ), redirect_stdout(StringIO()):
                controller = AppController()
                server = AppDeckServer(("127.0.0.1", 0), "test-pairing-code", controller)
                device_token = server.devices.pair("Test phone")
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    url = f"http://127.0.0.1:{server.server_port}"
                    request = Request(
                        url + "/api/apps/sample.desktop/favorite",
                        data=b'{"enabled":true}',
                        headers={
                            "Authorization": f"Bearer {device_token}",
                            "Content-Type": "application/json",
                        },
                        method="POST",
                    )
                    with urlopen(request, timeout=2) as response:
                        self.assertEqual(response.status, 200)

                    request = Request(
                        url + "/api/apps",
                        headers={"Authorization": f"Bearer {device_token}"},
                    )
                    with urlopen(request, timeout=2) as response:
                        payload = json.load(response)
                    self.assertTrue(payload["apps"][0]["selected"])
                    self.assertEqual(payload["apps"][0]["icon"], "data:image/png;base64,dGVzdA==")
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_shared_card_order_persists_and_rejects_stale_or_invalid_requests(self):
        import json
        import tempfile

        catalog = {
            "z.desktop": {"id": "z.desktop", "name": "Alpha", "argv": ["/bin/true"]},
            "a.desktop": {"id": "a.desktop", "name": "Zulu", "argv": ["/bin/true"]},
            "m.desktop": {"id": "m.desktop", "name": "New", "argv": ["/bin/true"]},
        }
        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.config_home", return_value=Path(temporary) / "config"
        ), patch("appdeck_server.state_home", return_value=Path(temporary) / "state"), patch(
            "appdeck_server.discover_apps", return_value=catalog
        ), patch("appdeck_server.resolve_app_icons", return_value=({}, "")), redirect_stdout(StringIO()):
            controller = AppController()
            controller.config_path.parent.mkdir(parents=True)
            controller.config_path.write_text(json.dumps({"apps": ["a.desktop", "z.desktop"]}))
            server = AppDeckServer(("127.0.0.1", 0), "test-token", controller)
            device_token = server.devices.pair("Test phone")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"

            def call(path, payload=None):
                return urlopen(Request(
                    base + path,
                    data=json.dumps(payload).encode() if payload is not None else None,
                    headers={"Authorization": f"Bearer {device_token}", "Content-Type": "application/json"},
                ), timeout=2)

            try:
                with call("/api/apps") as response:
                    first = json.load(response)
                self.assertEqual([app["id"] for app in first["apps"] if app["selected"]],
                                 ["z.desktop", "a.desktop"])
                with call("/api/order", {"order": ["a.desktop", "z.desktop"], "revision": first["revision"]}) as response:
                    self.assertEqual(response.status, 200)
                with call("/api/ping", {}) as response:
                    self.assertNotEqual(json.load(response)["revision"], first["revision"])
                with call("/api/apps") as response:
                    second = json.load(response)
                self.assertEqual([app["id"] for app in second["apps"] if app["selected"]],
                                 ["a.desktop", "z.desktop"])
                self.assertEqual(AppController().ordered_ids(catalog), ["a.desktop", "z.desktop"])
                for payload, expected in [
                    ({"order": ["z.desktop", "a.desktop"], "revision": first["revision"]}, 409),
                    ({"order": ["a.desktop", "a.desktop"], "revision": second["revision"]}, 409),
                    ({"order": ["a.desktop", 1], "revision": second["revision"]}, 400),
                ]:
                    with self.assertRaises(HTTPError) as error:
                        call("/api/order", payload)
                    self.assertEqual(error.exception.code, expected)
                    error.exception.close()
                with call("/api/apps/m.desktop/favorite", {"enabled": True}) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(controller.ordered_ids(catalog), ["a.desktop", "z.desktop", "m.desktop"])
                with call("/api/apps/z.desktop/favorite", {"enabled": False}) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(controller.ordered_ids(catalog), ["a.desktop", "m.desktop"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_phone_connection_expires_after_heartbeat_stops(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("appdeck_server.config_home", return_value=root / "config"), patch(
                "appdeck_server.state_home", return_value=root / "state"
            ), redirect_stdout(StringIO()):
                server = AppDeckServer(("127.0.0.1", 0), "test-pairing-code", AppController())
                try:
                    server.mark_phone_activity(now=100)
                    self.assertTrue(server.phone_connected)
                    self.assertFalse(server.expire_phone_connection(now=130))
                    self.assertTrue(server.expire_phone_connection(now=146))
                    self.assertFalse(server.phone_connected)
                finally:
                    server.server_close()

    def test_manual_pairing_exchanges_code_and_limits_failed_attempts(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("appdeck_server.config_home", return_value=root / "config"), patch(
                "appdeck_server.state_home", return_value=root / "state"
            ), redirect_stdout(StringIO()):
                server = AppDeckServer(("127.0.0.1", 0), "long-test-token", AppController())
                server.pairing_code = "00123456"
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_port}"

                def pair(code, origin=None):
                    request = Request(
                        base + "/api/pair",
                        data=json.dumps({"code": code}).encode(),
                        headers={"Origin": origin or base, "Content-Type": "application/json"},
                        method="POST",
                    )
                    return urlopen(request, timeout=2)

                try:
                    with pair("0012-3456") as response:
                        first = json.load(response)["token"]
                    with pair("00123456") as response:
                        second = json.load(response)["token"]
                    self.assertNotEqual(first, second)
                    self.assertTrue(server.devices.authorize(first))
                    self.assertTrue(server.devices.authorize(second))
                    self.assertFalse(server.devices.authorize("long-test-token"))
                    with self.assertRaises(HTTPError) as forbidden:
                        pair("00123456", "http://attacker.invalid")
                    self.assertEqual(forbidden.exception.code, 403)
                    forbidden.exception.close()
                    for _ in range(5):
                        with self.assertRaises(HTTPError) as wrong:
                            pair("9999-9999")
                        self.assertEqual(wrong.exception.code, 401)
                        wrong.exception.close()
                    with self.assertRaises(HTTPError) as limited:
                        pair("0012-3456")
                    self.assertEqual(limited.exception.code, 429)
                    limited.exception.close()
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_service_restart_preserves_pairing_until_disconnect(self):
        import json
        import os
        import select
        import socket
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "config" / "appdeck"
            config.mkdir(parents=True)
            origin = "https://deck.example:8443"
            (config / "connection.json").write_text(json.dumps({"origins": [origin]}))
            runtime = root / "runtime"
            runtime.mkdir()
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"),
                       XDG_STATE_HOME=str(root / "state"), XDG_RUNTIME_DIR=str(runtime))
            base = f"http://127.0.0.1:{port}"
            server = None

            def start():
                process = subprocess.Popen(
                    [sys.executable, "-u", "-c",
                     f"import appdeck_server; appdeck_server.PORT = {port}; appdeck_server.main()"],
                    cwd=Path(__file__).resolve().parent.parent, env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                if not select.select([process.stdout], [], [], 10)[0]:
                    process.terminate()
                    process.communicate(timeout=5)
                    self.fail("App Deck service did not start")
                line = process.stdout.readline()
                if not line:
                    _, error = process.communicate(timeout=5)
                    self.fail(f"App Deck service failed to start: {error}")
                return process, json.loads(line)

            def request(path, data, token=""):
                return urlopen(Request(
                    base + path, data=data,
                    headers={"Host": "deck.example:8443", "Origin": origin,
                             "Content-Type": "application/json",
                             "Authorization": f"Bearer {token}"},
                    method="POST",
                ), timeout=2)

            try:
                server, info = start()
                with request("/api/pair", json.dumps({"code": info["pairingCode"]}).encode()) as response:
                    old_token = json.load(response)["token"]
                with request("/api/ping", b"", old_token) as response:
                    self.assertEqual(response.status, 200)
                server.terminate()
                server.communicate(timeout=5)
                server, info = start()
                with request("/api/ping", b"", old_token) as response:
                    self.assertEqual(response.status, 200)
                result = subprocess.run(
                    [sys.executable, "connection_setup.py", "disconnect"],
                    cwd=Path(__file__).resolve().parent.parent, env=env,
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                server.terminate()
                server.communicate(timeout=5)
                server, info = start()
                with self.assertRaises(HTTPError) as revoked:
                    request("/api/ping", b"", old_token)
                self.assertEqual(revoked.exception.code, 401)
                revoked.exception.close()
                with request("/api/pair", json.dumps({"code": info["pairingCode"]}).encode()) as response:
                    new_token = json.load(response)["token"]
                self.assertNotEqual(old_token, new_token)
                with request("/api/ping", b"", new_token) as response:
                    self.assertEqual(response.status, 200)
            finally:
                if server and server.poll() is None:
                    server.terminate()
                    server.communicate(timeout=5)

    def test_pairing_file_is_private_and_invalid_files_fail_closed(self):
        import tempfile
        from appdeck_server import pairing_token

        with tempfile.TemporaryDirectory() as temporary, patch(
            "appdeck_server.state_home", return_value=Path(temporary)
        ):
            token = pairing_token()
            path = Path(temporary) / "appdeck/pairing.json"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(pairing_token(), token)
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "must be private"):
                pairing_token()
            path.chmod(0o600)
            path.write_text("null")
            with self.assertRaisesRegex(RuntimeError, "invalid"):
                pairing_token()


if __name__ == "__main__":
    unittest.main()
