"""Local-only integration coverage for the synthetic traffic simulator."""

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.client import HTTPConnection
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request
from urllib.request import urlopen

from lab import HOST, MAX_EVENTS, ROOT, EventStore, LabServer, get_report, local_open, run_virtual_device


@contextmanager
def receiver(**kwargs):
    with LabServer(port=0, **kwargs) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join(timeout=3)


def saved_event(sequence=1):
    return {"synthetic": True, "received_at": "2026-10-23T00:00:00+00:00",
            "claimed_device": "desktop", "virtual_id": "store-test", "sequence": sequence,
            "action": "synthetic-request", "page": "/lab/event", "observed_ip": HOST,
            "reported_user_agent": "LabSimulator/test"}


class ReceiverTests(unittest.TestCase):
    def test_malformed_events_return_400_without_breaking_receiver(self):
        valid = {"claimed_device": "android", "virtual_id": "test", "sequence": 1}
        invalid = [None, [], "text", {}, dict(valid, claimed_device=[]),
                   dict(valid, claimed_device="unknown"), dict(valid, virtual_id=""),
                   dict(valid, virtual_id="x" * 65), dict(valid, sequence=True),
                   dict(valid, sequence=0), dict(valid, sequence=1.5),
                   dict(valid, action={}), dict(valid, page="x" * 101)]
        with receiver() as server:
            url = f"http://{HOST}:{server.server_port}/lab/event"
            for payload in invalid:
                with self.subTest(payload=payload):
                    with self.assertRaises(HTTPError) as caught:
                        local_open(Request(url, json.dumps(payload).encode(), method="POST"))
                    self.assertEqual(caught.exception.code, 400)
                    self.assertIn("error", json.load(caught.exception))
            for body in (b"{broken", b"\xff", b"x" * 4097):
                with self.assertRaises(HTTPError) as caught:
                    local_open(Request(url, body, method="POST"))
                self.assertEqual(caught.exception.code, 400)
            run_virtual_device("android", "still-alive", 1, 0.2, server.server_port)
            self.assertEqual(get_report(server.server_port)["total_events"], 1)

    def test_invalid_content_lengths(self):
        with receiver() as server:
            for length in ("-1", "0", "4097", "garbage"):
                connection = HTTPConnection(HOST, server.server_port, timeout=5)
                try:
                    connection.request("POST", "/lab/event", headers={"Content-Length": length})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    response.read()
                finally:
                    connection.close()

    def test_routes_health_queries_and_download(self):
        with receiver() as server:
            base = f"http://{HOST}:{server.server_port}"
            for route in ("/", "/shows", "/trending?test=1", "/videos", "/lab/dashboard/"):
                with local_open(base + route) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("text/html", response.headers["Content-Type"])
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
            with local_open(base + "/lab/health") as response:
                self.assertEqual(json.load(response), {"ok": True, "synthetic_only": True})
            with local_open(base + "/lab/report?download=1") as response:
                self.assertIn("attachment", response.headers["Content-Disposition"])
                self.assertEqual(json.load(response)["total_events"], 0)
            with local_open(base + "/favicon.ico") as response:
                self.assertEqual(response.status, 204)
            with self.assertRaises(HTTPError) as caught:
                local_open(base + "/missing")
            self.assertEqual(caught.exception.code, 404)

    def test_twelve_concurrent_devices_are_counted(self):
        with receiver() as server:
            devices = ["android", "ios", "desktop", "tablet"] * 3
            with ThreadPoolExecutor(max_workers=12) as pool:
                jobs = [pool.submit(run_virtual_device, device, f"device-{i}", 3, 0.2,
                                    server.server_port) for i, device in enumerate(devices)]
                for job in jobs:
                    job.result()
            report = get_report(server.server_port)
            self.assertEqual(report["total_events"], 36)
            self.assertEqual(report["virtual_sessions"], 12)
            self.assertEqual(report["by_claimed_device"], dict.fromkeys(set(devices), 9))
            self.assertEqual(report["by_observed_ip"], {HOST: 36})
            self.assertEqual(len(report["recent_events"]), 10)

    def test_restart_restores_events(self):
        with TemporaryDirectory() as temp:
            log = Path(temp) / "events.jsonl"
            with receiver(log_path=log) as server:
                run_virtual_device("tablet", "persisted", 2, 0.2, server.server_port)
                before = get_report(server.server_port)
            with receiver(log_path=log) as server:
                self.assertEqual(get_report(server.server_port), before)
            self.assertEqual(len(log.read_text().splitlines()), 2)

    def test_log_write_failure_returns_503(self):
        with receiver() as server:
            with patch.object(server.store, "add", side_effect=OSError("disk full")):
                with self.assertRaises(HTTPError) as caught:
                    run_virtual_device("desktop", "disk-error", 1, 0.2, server.server_port)
                self.assertEqual(caught.exception.code, 503)
            self.assertEqual(get_report(server.server_port)["total_events"], 0)

    def test_artifacts_runs_and_traversal(self):
        with TemporaryDirectory() as temp:
            artifacts = Path(temp) / "artifacts"
            folder = artifacts / "test-run"
            folder.mkdir(parents=True)
            (folder / "screen.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            (folder / "session-trace.zip").write_bytes(b"PK\x03\x04trace-test")
            (folder / "return-trace.zip").write_bytes(b"PK\x03\x04return-test")
            (folder / "dashboard-trace.zip").write_bytes(b"PK\x03\x04dashboard-test")
            (folder / "summary.json").write_text(json.dumps({"browser": "chrome", "sessions": [
                {"profile": "desktop", "journey": "returning", "screenshot": str(folder / "screen.png"),
                 "traces": [str(folder / "session-trace.zip"), str(folder / "return-trace.zip"),
                            str(folder / "missing-trace.zip")]}
            ], "dashboard_trace": str(folder / "dashboard-trace.zip")}))
            (Path(temp) / "secret.json").write_text('{"secret":true}')
            broken = artifacts / "broken-run"
            broken.mkdir()
            (broken / "summary.json").write_text('{"sessions":["bad"]}')
            with receiver(artifacts_dir=artifacts) as server:
                base = f"http://{HOST}:{server.server_port}"
                with local_open(base + "/lab/runs") as response:
                    runs = json.load(response)["runs"]
                self.assertEqual(len(runs), 1)
                self.assertEqual(runs[0]["session_count"], 1)
                with local_open(base + runs[0]["screenshots"][0]["url"]) as response:
                    self.assertEqual(response.headers["Content-Type"], "image/png")
                self.assertEqual(len(runs[0]["traces"]), 3)
                self.assertEqual(runs[0]["sessions"][0]["journey"], "returning")
                for trace in runs[0]["traces"]:
                    with local_open(base + trace["url"]) as response:
                        self.assertEqual(response.headers["Content-Type"], "application/zip")
                        self.assertIn("attachment; filename=", response.headers["Content-Disposition"])
                        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                        self.assertTrue(response.read().startswith(b"PK"))
                for route in ("/lab/artifacts/%2e%2e/secret.json", "/lab/artifacts/../secret.json",
                              "/lab/artifacts/%2e%2e/secret.zip", "/lab/artifacts/missing.zip",
                              "/lab/artifacts/missing.png", "/lab/artifacts/test-run/file.py"):
                    with self.assertRaises(HTTPError) as caught:
                        local_open(base + route)
                    self.assertEqual(caught.exception.code, 404)

    def test_cli_repeat_runs_have_unique_sessions_and_export_matches(self):
        with TemporaryDirectory() as temp, receiver() as server:
            command = [sys.executable, str(ROOT / "lab.py"), "simulate", "--port",
                       str(server.server_port), "--devices", "android,ios,desktop,tablet",
                       "--count", "1", "--interval", "0.2"]
            for _ in range(2):
                result = subprocess.run(command, capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
            report = get_report(server.server_port)
            self.assertEqual(report["virtual_sessions"], 8)
            output = Path(temp) / "nested" / "report.json"
            result = subprocess.run([sys.executable, str(ROOT / "lab.py"), "report", "--port",
                                     str(server.server_port), "--output", str(output)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(output.read_text()), report)

    def test_cli_rejects_invalid_limits(self):
        for args in (("simulate", "--interval", "nan"), ("simulate", "--interval", "inf"),
                     ("simulate", "--count", "0"), ("simulate", "--devices", "unknown"),
                     ("report", "--port", "0"), ("serve", "--port", "65536")):
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, str(ROOT / "lab.py"), *args],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("Traceback", result.stderr)


class StoreTests(unittest.TestCase):
    def test_retention_keeps_latest_5000_and_full_disk_log(self):
        with TemporaryDirectory() as temp:
            log = Path(temp) / "events.jsonl"
            store = EventStore(log)
            for i in range(1, MAX_EVENTS + 3):
                store.add(saved_event(i))
            report = store.report()
            self.assertEqual(report["total_events"], MAX_EVENTS)
            self.assertEqual(store.events[0]["sequence"], 3)
            self.assertEqual(report["recent_events"][-1]["sequence"], MAX_EVENTS + 2)
            self.assertEqual(len(log.read_text().splitlines()), MAX_EVENTS + 2)
            self.assertEqual(EventStore(log).report(), report)

    def test_corrupt_and_unterminated_log_recovers(self):
        with TemporaryDirectory() as temp:
            log = Path(temp) / "events.jsonl"
            log.write_bytes(json.dumps(saved_event()).encode() + b'\n\xff\n{"partial":')
            with self.assertWarns(RuntimeWarning):
                store = EventStore(log)
            store.add(saved_event(2))
            with self.assertWarns(RuntimeWarning):
                restored = EventStore(log)
            self.assertEqual(restored.report()["total_events"], 2)

    def test_concurrent_writes_produce_valid_jsonl(self):
        with TemporaryDirectory() as temp:
            log = Path(temp) / "events.jsonl"
            store = EventStore(log)
            with ThreadPoolExecutor(max_workers=12) as pool:
                list(pool.map(lambda i: store.add(saved_event(i)), range(1, 101)))
            self.assertEqual(len([json.loads(line) for line in log.read_text().splitlines()]), 100)
            self.assertEqual(EventStore(log).report()["total_events"], 100)


class LabTests(unittest.TestCase):
    def test_three_virtual_devices_share_loopback_ip(self):
        self.assertEqual(HOST, "127.0.0.1")
        server = LabServer(port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_port
            for device in ("android", "ios", "desktop"):
                run_virtual_device(device, f"test-{device}", 2, 0.2, port)
            report = get_report(port)
            self.assertTrue(report["synthetic_only"])
            self.assertEqual(report["total_events"], 6)
            self.assertEqual(report["by_observed_ip"], {"127.0.0.1": 6})
            self.assertEqual(report["by_claimed_device"],
                             {"android": 2, "ios": 2, "desktop": 2})
            self.assertEqual(report["by_action"], {"synthetic-request": 6})
            self.assertEqual(report["virtual_sessions"], 3)

            with urlopen(f"http://{HOST}:{port}/", timeout=5) as response:
                site = response.read().decode("utf-8")
                self.assertIn("SYNTHETIC / NO ADS", site)
                self.assertNotIn("ftd.agency", site)
            with urlopen(f"http://{HOST}:{port}/lab/dashboard", timeout=5) as response:
                dashboard = response.read().decode("utf-8")
                self.assertIn("Device lab dashboard", dashboard)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
