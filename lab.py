"""Local-only synthetic device traffic lab (no real advertising requests)."""

from __future__ import annotations

import argparse
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import sys
import threading
from urllib.error import URLError
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4
import warnings

HOST = "127.0.0.1"
DEVICE_TYPES = {"android", "ios", "desktop", "tablet"}
MAX_EVENTS = 5000
ROOT = Path(__file__).resolve().parent
SITE_DIR = ROOT / "site"
ARTIFACTS_DIR = ROOT / "artifacts"


def validate_payload(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Event must be a JSON object")
    device = payload.get("claimed_device")
    if not isinstance(device, str) or device not in DEVICE_TYPES:
        raise ValueError("Invalid claimed device")
    virtual_id = payload.get("virtual_id")
    if not isinstance(virtual_id, str) or not virtual_id.strip() or len(virtual_id) > 64:
        raise ValueError("Virtual ID must contain 1-64 characters")
    sequence = payload.get("sequence")
    if type(sequence) is not int or not 1 <= sequence <= 1_000_000:
        raise ValueError("Sequence must be an integer from 1 to 1000000")
    for key, limit in (("action", 64), ("page", 100)):
        value = payload.get(key, "synthetic-request" if key == "action" else "/lab/event")
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(f"{key} must contain 1-{limit} characters")
    return payload


class EventStore:
    def __init__(self, log_path: Path | None = None) -> None:
        self.events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self.lock = threading.Lock()
        self.log_path = Path(log_path) if log_path is not None else None
        if self.log_path is not None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            invalid = 0
            if self.log_path.exists():
                with self.log_path.open("rb") as stream:
                    for line in stream:
                        try:
                            event = validate_payload(json.loads(line))
                            if not all(isinstance(event.get(key), str) for key in
                                       ("received_at", "observed_ip", "reported_user_agent", "action", "page")):
                                raise ValueError("Incomplete saved event")
                            self.events.append(event)
                        except (ValueError, TypeError):
                            invalid += 1
                # Repair an unterminated last record after a process interruption.
                with self.log_path.open("rb+") as stream:
                    if stream.seek(0, 2):
                        stream.seek(-1, 2)
                        if stream.read(1) != b"\n":
                            stream.write(b"\n")
            if invalid:
                warnings.warn(f"Skipped {invalid} invalid saved event(s)", RuntimeWarning)

    def add(self, event: dict) -> None:
        with self.lock:
            if self.log_path is not None:
                with self.log_path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(event, ensure_ascii=True) + "\n")
            self.events.append(event)

    def report(self) -> dict:
        with self.lock:
            events = list(self.events)
        return {
            "synthetic_only": True,
            "total_events": len(events),
            "event_limit": MAX_EVENTS,
            "by_claimed_device": dict(Counter(e["claimed_device"] for e in events)),
            "by_observed_ip": dict(Counter(e["observed_ip"] for e in events)),
            "by_action": dict(Counter(e["action"] for e in events)),
            "virtual_sessions": len({e["virtual_id"] for e in events}),
            "recent_events": events[-10:],
        }


class LabHandler(BaseHTTPRequestHandler):
    server: "LabServer"

    def send_body(self, status: int, body: bytes, content_type: str,
                  download: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, obj: dict, download: str | None = None) -> None:
        self.send_body(status, json.dumps(obj).encode("utf-8"), "application/json", download)

    def send_html(self, filename: str) -> None:
        try:
            body = (SITE_DIR / filename).read_bytes()
        except FileNotFoundError:
            return self.send_json(404, {"error": "Lab page not installed"})
        self.send_body(200, body, "text/html; charset=utf-8")

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        route = url.path
        if route in {"/", "/shows", "/trending", "/videos"}:
            return self.send_html("index.html")
        if route.rstrip("/") == "/lab/dashboard":
            return self.send_html("dashboard.html")
        if route == "/lab/report":
            download = "lab-report.json" if "download" in parse_qs(url.query) else None
            return self.send_json(200, self.server.store.report(), download)
        if route == "/lab/health":
            return self.send_json(200, {"ok": True, "synthetic_only": True})
        if route == "/lab/runs":
            return self.send_json(200, {"runs": self.server.recent_runs()})
        if route.startswith("/lab/artifacts/"):
            target = (self.server.artifacts_dir / unquote(route[len("/lab/artifacts/"):])).resolve()
            if (not target.is_relative_to(self.server.artifacts_dir) or
                    target.suffix not in {".png", ".json", ".zip"} or not target.is_file()):
                return self.send_json(404, {"error": "Artifact not found"})
            content_type = {".png": "image/png", ".json": "application/json", ".zip": "application/zip"}[target.suffix]
            return self.send_body(200, target.read_bytes(), content_type,
                                  target.name if target.suffix == ".zip" else None)
        if route == "/favicon.ico":
            return self.send_body(204, b"", "image/x-icon")
        self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/lab/event":
            return self.send_json(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError("Invalid event size")
            payload = validate_payload(json.loads(self.rfile.read(size)))
        except (ValueError, TypeError, UnicodeDecodeError) as error:
            return self.send_json(400, {"error": str(error)})
        event = {
            "synthetic": True,
            "received_at": datetime.now(timezone.utc).isoformat(),
            "observed_ip": self.client_address[0],
            "claimed_device": payload["claimed_device"],
            "virtual_id": payload["virtual_id"],
            "sequence": payload["sequence"],
            "action": payload.get("action", "synthetic-request"),
            "page": payload.get("page", "/lab/event"),
            "reported_user_agent": self.headers.get("User-Agent", "")[:160],
        }
        try:
            self.server.store.add(event)
        except OSError:
            return self.send_json(503, {"error": "Cannot write the local event log"})
        self.send_json(201, {"accepted": True, "synthetic_only": True})

    def log_message(self, format: str, *args: object) -> None:
        pass


class LabServer(ThreadingHTTPServer):
    def __init__(self, port: int = 8765, log_path: Path | None = None,
                 artifacts_dir: Path = ARTIFACTS_DIR) -> None:
        self.store = EventStore(log_path)
        self.artifacts_dir = Path(artifacts_dir).resolve()
        super().__init__((HOST, port), LabHandler)

    def recent_runs(self) -> list[dict]:
        runs = []
        if not self.artifacts_dir.exists():
            return runs
        for folder in sorted(self.artifacts_dir.iterdir(), reverse=True):
            if not folder.is_dir() or not folder.resolve().is_relative_to(self.artifacts_dir):
                continue
            try:
                summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
                if not isinstance(summary, dict):
                    continue
                sessions = summary["sessions"]
                if not isinstance(sessions, list) or any(not isinstance(s, dict) for s in sessions):
                    continue
                def artifact_link(filename: object, label: str) -> dict | None:
                    if not isinstance(filename, str):
                        return None
                    name = Path(filename).name
                    candidate = (folder / name).resolve()
                    if (not candidate.is_relative_to(folder.resolve()) or not candidate.is_file()
                            or candidate.suffix not in {".png", ".json", ".zip"}):
                        return None
                    return {"label": label, "url": f"/lab/artifacts/{quote(folder.name)}/{quote(name)}"}

                traces, screenshots = [], []
                for index, session in enumerate(sessions):
                    label = f"{session.get('profile', 'unknown')} {index + 1} / {session.get('journey', 'browse')}"
                    for number, filename in enumerate(session.get("traces") or [session.get("trace")]):
                        link = artifact_link(filename, f"Trace: {label} ({number + 1})")
                        if link:
                            traces.append(link)
                    link = artifact_link(session.get("screenshot"), label)
                    if link:
                        screenshots.append(link)
                for key, items, label in (("dashboard_trace", traces, "Dashboard trace"),
                                          ("dashboard_screenshot", screenshots, "Dashboard")):
                    link = artifact_link(summary.get(key), label)
                    if link:
                        items.append(link)
                runs.append({
                    "id": folder.name,
                    "status": summary.get("status", "passed"),
                    "browser": summary.get("browser", "chromium"),
                    "session_count": len(sessions),
                    "summary_url": f"/lab/artifacts/{quote(folder.name)}/summary.json",
                    "target": (summary.get("target") or {}).get("name", "Bundled staging site"),
                    "sessions": sessions,
                    "traces": traces,
                    "screenshots": screenshots,
                })
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                continue
            if len(runs) == 20:
                break
        return runs


def local_open(request: str | Request):
    # Local lab connections must not be sent through a machine-wide proxy.
    return build_opener(ProxyHandler({})).open(request, timeout=5)


def run_virtual_device(device: str, virtual_id: str, count: int, interval: float, port: int) -> None:
    url = f"http://{HOST}:{port}/lab/event"
    for sequence in range(1, count + 1):
        payload = json.dumps({"claimed_device": device, "virtual_id": virtual_id,
                              "sequence": sequence}).encode("utf-8")
        request = Request(url, data=payload, headers={
            "Content-Type": "application/json",
            "User-Agent": f"LabSimulator/1.0 ({device}; synthetic)",
        }, method="POST")
        with local_open(request) as response:
            if response.status != 201:
                raise RuntimeError(f"Unexpected lab response: {response.status}")
        if sequence < count:
            threading.Event().wait(interval)


def get_report(port: int) -> dict:
    with local_open(f"http://{HOST}:{port}/lab/report") as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    server_parser = commands.add_parser("serve", help="Start the loopback-only lab receiver")
    server_parser.add_argument("--port", type=int, default=8765)
    server_parser.add_argument("--event-log", type=Path, default=ARTIFACTS_DIR / "events.jsonl")
    server_parser.add_argument("--no-persist", action="store_true", help="Keep events in memory only")
    server_parser.add_argument("--artifacts-dir", type=Path, default=ARTIFACTS_DIR,
                               help="Directory served by the dashboard artifact viewer")
    simulator = commands.add_parser("simulate", help="Generate synthetic device events")
    simulator.add_argument("--devices", default="android,ios,desktop")
    simulator.add_argument("--count", type=int, default=5, help="Events per virtual device (1-100)")
    simulator.add_argument("--interval", type=float, default=2.0, help="Seconds between events (>= 0.2)")
    simulator.add_argument("--port", type=int, default=8765)
    report_parser = commands.add_parser("report", help="Read or export the current lab report")
    report_parser.add_argument("--port", type=int, default=8765)
    report_parser.add_argument("--output", type=Path, help="Also save the JSON report to this file")
    args = parser.parse_args()
    if not (0 if args.command == "serve" else 1) <= args.port <= 65535:
        parser.error("Port must be 1-65535 (serve also accepts 0 for an available port)")
    try:
        if args.command == "serve":
            with LabServer(args.port, None if args.no_persist else args.event_log, args.artifacts_dir) as server:
                print(f"Synthetic lab receiver: http://{HOST}:{server.server_port}/lab/report", flush=True)
                print(f"Dashboard: http://{HOST}:{server.server_port}/lab/dashboard", flush=True)
                print(f"Event log: {server.store.log_path or 'in memory'}", flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    print("\nStopped.")
        elif args.command == "report":
            text = json.dumps(get_report(args.port), indent=2)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(text + "\n", encoding="utf-8")
            print(text)
        else:
            devices = [item.strip().lower() for item in args.devices.split(",")]
            if not 1 <= len(devices) <= 12 or any(d not in DEVICE_TYPES for d in devices):
                parser.error("Use 1-12 devices from: android, ios, desktop, tablet")
            if not 1 <= args.count <= 100 or not math.isfinite(args.interval) or args.interval < 0.2:
                parser.error("Count must be 1-100 and interval must be finite and >= 0.2 seconds")
            run_id = uuid4().hex[:12]
            with ThreadPoolExecutor(max_workers=len(devices)) as pool:
                futures = [pool.submit(run_virtual_device, d, f"virtual-{run_id}-{i}-{d}",
                                       args.count, args.interval, args.port)
                           for i, d in enumerate(devices, 1)]
                for future in futures:
                    future.result()
            print(json.dumps(get_report(args.port), indent=2))
    except (OSError, URLError, ValueError) as error:
        print(f"Lab failed: {error}. Start the receiver with: python lab.py serve", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
