"""Local-only synthetic device traffic lab (no real advertising requests)."""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from urllib.request import Request, urlopen


HOST = "127.0.0.1"
DEVICE_TYPES = {"android", "ios", "desktop", "tablet"}
MAX_EVENTS = 5000


class EventStore:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.lock = threading.Lock()

    def add(self, event: dict) -> None:
        with self.lock:
            self.events.append(event)
            if len(self.events) > MAX_EVENTS:
                del self.events[:-MAX_EVENTS]

    def report(self) -> dict:
        with self.lock:
            events = list(self.events)
        return {
            "synthetic_only": True,
            "total_events": len(events),
            "by_claimed_device": dict(Counter(e["claimed_device"] for e in events)),
            "by_observed_ip": dict(Counter(e["observed_ip"] for e in events)),
            "recent_events": events[-10:],
        }


class LabHandler(BaseHTTPRequestHandler):
    server: "LabServer"

    def send_json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/lab/report":
            return self.send_json(200, self.server.store.report())
        if self.path == "/lab/health":
            return self.send_json(200, {"ok": True, "synthetic_only": True})
        self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/lab/event":
            return self.send_json(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError("Invalid event size")
            payload = json.loads(self.rfile.read(size))
            device = payload.get("claimed_device")
            if (device not in DEVICE_TYPES or
                    not isinstance(payload.get("virtual_id"), str) or
                    not isinstance(payload.get("sequence"), int)):
                raise ValueError("Invalid virtual device event")
        except (ValueError, TypeError, AttributeError, json.JSONDecodeError) as error:
            return self.send_json(400, {"error": str(error)})

        event = {
            "synthetic": True,
            "received_at": datetime.now(timezone.utc).isoformat(),
            "observed_ip": self.client_address[0],
            "claimed_device": device,
            "virtual_id": payload["virtual_id"][:64],
            "sequence": payload["sequence"],
            "reported_user_agent": self.headers.get("User-Agent", "")[:160],
        }
        self.server.store.add(event)
        self.send_json(201, {"accepted": True, "synthetic_only": True})

    def log_message(self, format: str, *args: object) -> None:
        return  # Keep terminal output focused on the lab report.


class LabServer(ThreadingHTTPServer):
    def __init__(self, port: int = 8765) -> None:
        super().__init__((HOST, port), LabHandler)
        self.store = EventStore()


def run_virtual_device(device: str, virtual_id: str, count: int, interval: float, port: int) -> None:
    # Hardcoded loopback target: this lab cannot send traffic to a live website.
    url = f"http://{HOST}:{port}/lab/event"
    for sequence in range(1, count + 1):
        payload = json.dumps({
            "claimed_device": device,
            "virtual_id": virtual_id,
            "sequence": sequence,
        }).encode("utf-8")
        request = Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"LabSimulator/1.0 ({device}; synthetic)",
            },
            method="POST",
        )
        with urlopen(request, timeout=5) as response:
            if response.status != 201:
                raise RuntimeError(f"Unexpected lab response: {response.status}")
        if sequence < count:
            threading.Event().wait(interval)


def get_report(port: int) -> dict:
    with urlopen(f"http://{HOST}:{port}/lab/report", timeout=5) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    server_parser = commands.add_parser("serve", help="Start the loopback-only lab receiver")
    server_parser.add_argument("--port", type=int, default=8765)
    simulator = commands.add_parser("simulate", help="Generate synthetic device events")
    simulator.add_argument("--devices", default="android,ios,desktop")
    simulator.add_argument("--count", type=int, default=5, help="Events per virtual device (1-100)")
    simulator.add_argument("--interval", type=float, default=2.0, help="Seconds between events (>= 0.2)")
    simulator.add_argument("--port", type=int, default=8765)
    report_parser = commands.add_parser("report", help="Read the current lab report")
    report_parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if args.command == "serve":
        with LabServer(args.port) as server:
            print(f"Synthetic lab receiver: http://{HOST}:{server.server_port}/lab/report")
            print("Listening on loopback only; no real advertiser requests.")
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                print("\nStopped.")
    elif args.command == "report":
        print(json.dumps(get_report(args.port), indent=2))
    else:
        devices = [item.strip().lower() for item in args.devices.split(",")]
        if not 1 <= len(devices) <= 12 or any(d not in DEVICE_TYPES for d in devices):
            parser.error("Use 1-12 devices from: android, ios, desktop, tablet")
        if not 1 <= args.count <= 100 or args.interval < 0.2:
            parser.error("Count must be 1-100 and interval must be >= 0.2 seconds")
        with ThreadPoolExecutor(max_workers=len(devices)) as pool:
            futures = [pool.submit(run_virtual_device, d, f"virtual-{i}-{d}", args.count,
                                   args.interval, args.port) for i, d in enumerate(devices, 1)]
            for future in futures:
                future.result()
        print(json.dumps(get_report(args.port), indent=2))


if __name__ == "__main__":
    main()
