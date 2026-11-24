import unittest
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO
from threading import Thread
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

from appdeck_server import AppController, AppDeckServer, parse_exec, public_origin, public_origins
import connection_setup


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
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/api/ping"
            try:
                for headers, status in [
                    ({"Host": "deck.example:8443", "Origin": origin, "Authorization": "Bearer test-token"}, 200),
                    ({"Host": "wrong.example:8443", "Origin": origin, "Authorization": "Bearer test-token"}, 403),
                    ({"Host": "deck.example:8443", "Origin": "http://deck.example:8443", "Authorization": "Bearer test-token"}, 403),
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
                        "Host": host, "Origin": origin, "Authorization": "Bearer test-token"
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
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    url = f"http://127.0.0.1:{server.server_port}"
                    request = Request(
                        url + "/api/apps/sample.desktop/favorite",
                        data=b'{"enabled":true}',
                        headers={
                            "Authorization": "Bearer test-pairing-code",
                            "Content-Type": "application/json",
                        },
                        method="POST",
                    )
                    with urlopen(request, timeout=2) as response:
                        self.assertEqual(response.status, 200)

                    request = Request(
                        url + "/api/apps",
                        headers={"Authorization": "Bearer test-pairing-code"},
                    )
                    with urlopen(request, timeout=2) as response:
                        payload = json.load(response)
                    self.assertTrue(payload["apps"][0]["selected"])
                    self.assertEqual(payload["apps"][0]["icon"], "data:image/png;base64,dGVzdA==")
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
                        self.assertEqual(json.load(response), {"token": "long-test-token"})
                    with pair("00123456") as response:
                        self.assertEqual(json.load(response), {"token": "long-test-token"})
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


if __name__ == "__main__":
    unittest.main()
