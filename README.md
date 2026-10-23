# RIENG Synthetic Device & Browser Lab

A local QA lab with a Python receiver, responsive staging site, live monitoring
dashboard and actual Playwright browser sessions. The request simulator generates
synthetic HTTP events; the browser simulator also executes JavaScript, checks the
mock player and navigation, and saves screenshots. Both target only `127.0.0.1`.
There are no advertisements, live streams or production impressions.

## Setup on Windows (PowerShell)

Requires Python 3.10+ and Node.js 20+. From the repository directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

This creates `.venv`, installs Python Playwright and its dependencies, installs the
locked Node dependencies, and checks browser availability. The browser runner uses
installed **Chrome**, then **Edge**, then Playwright's downloaded **Chromium**.
Chrome/Edge are used through supported Playwright channels; binaries do not need
copying. If none is available, setup downloads Chromium. To request the download:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -DownloadChromium
```

Manual installation:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --timeout 120 -r requirements-dev.txt
npm.cmd ci
node scripts/check-browser.cjs
# Only needed if you want the separate bundled browser:
npx.cmd playwright install chromium
```

The Python receiver itself requires only the standard library. Python Playwright
is available in `.venv` for additional automation; the included browser runner uses
Node Playwright. Their version numbers are pinned independently because Python
and Node do not always publish matching patch releases.

## Start and use the lab

Terminal 1, start the receiver and dashboard:

```powershell
cd D:\Ad_Traffic\my_app
npm.cmd start
```

Terminal 2, run desktop, Android, iPhone and tablet browser profiles:

```powershell
cd D:\Ad_Traffic\my_app
npm.cmd run browser:lab
```

Open **http://127.0.0.1:8765/lab/dashboard**. The dashboard refreshes every two
seconds, showing device/action totals, sessions, observed IPs, recent events,
saved browser runs, screenshot links, and a JSON report download. It shows
connection errors and resumes refreshing when the receiver returns.

More browser commands:

```powershell
# Repeated profiles create separate, isolated sessions (maximum 8 per run).
npm.cmd run browser:lab -- --profiles android,iphone,desktop,android
# Select a browser, or see its window.
npm.cmd run browser:lab -- --browser chrome
npm.cmd run browser:lab -- --browser msedge --headed
node browser_lab.cjs --help
```

The script checks play/pause, Shows, Trending and Videos routes, viewport fit,
scrolling and event acceptance. Each session records eight events. Every run gets
new session IDs, PNG screenshots, a dashboard screenshot, and `summary.json`.
Failed sessions produce an error summary and, when possible, a failure screenshot;
the command exits nonzero. Summaries include browser/version and observed device
viewport, scale factor, touch capability and user agent.

Generate synthetic requests without a browser (up to 12 devices, 100 events each):

```powershell
npm.cmd run simulate -- --devices android,ios,desktop,tablet --count 5 --interval 0.2
npm.cmd run report
npm.cmd run report -- --output artifacts\report.json
```

Direct Python equivalents, without activating the environment:

```powershell
.\.venv\Scripts\python.exe lab.py serve
.\.venv\Scripts\python.exe lab.py simulate --devices android,android,ios --count 3 --interval 1
.\.venv\Scripts\python.exe lab.py report --output artifacts\report.json
```

Stop the receiver with **Ctrl+C**. If port 8765 is already occupied, use
`npm.cmd start -- --port 8766` and add `--port 8766` to simulator/report commands.

## Events and artifacts

- `artifacts/events.jsonl`: append-only event log, restored on server restart.
- `artifacts/<timestamp>-<unique suffix>/summary.json`: browser run results and report snapshot.
- `artifacts/<timestamp>-<unique suffix>/*.png`: session and dashboard screenshots.
- `artifacts/report.json`: optional exported report.

Reports and dashboard totals cover the **latest 5,000 events**. Older events remain
in the full JSONL log. Use `lab.py serve --event-log PATH` for a separate history,
or `--no-persist` for an empty in-memory run. Corrupt/incomplete log records are
skipped with a warning; subsequent valid records can still be recovered.

`claimed_device` is an emulated label, not evidence of a physical device or a
unique person. The browser profiles use Chromium rendering even for iPhone/iPad;
they do not test Safari/WebKit or physical hardware. `observed_ip` is the actual
connection peer, normally `127.0.0.1`. Python request user agents are explicitly
marked `LabSimulator`; browser sessions report their emulated user agents.

The runner blocks requests outside the receiver's exact origin, blocks WebSockets
and service workers, and has no public target URL option. Each context has its own
cookies and storage. The receiver and artifact viewer listen only on loopback.

## Tests

No manually running receiver is required; integration tests create their own on
an available port. A usable Chrome, Edge or Playwright Chromium is required for
the browser suite.

```powershell
npm.cmd test
# Individual suites:
npm.cmd run test:python
npm.cmd run test:browser
```

Tests cover concurrent and repeated profiles, player/navigation/layout checks,
PNG dimensions, dashboard refresh/error recovery, JSON downloads, stored event
rendering, cookie/storage isolation, network blocking, validation, log retention,
restart recovery, report export and failure screenshots. Test artifacts are
preserved under `artifacts/` for inspection, and test receivers stop on completion.

On Linux/macOS use `python3 -m venv .venv`, `.venv/bin/python` and `npm` in place
of the Windows executable paths. npm commands automatically select the repository
virtual environment; `LAB_PYTHON` can override the interpreter.
