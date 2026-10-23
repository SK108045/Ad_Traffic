"""Local-only integration coverage for the synthetic traffic simulator."""

import threading
import unittest
from urllib.request import urlopen

from lab import HOST, LabServer, get_report, run_virtual_device


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
