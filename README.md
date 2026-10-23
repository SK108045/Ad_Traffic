# RIENG Device & Browser Lab

A Python receiver, responsive staging site, live dashboard and Playwright browser
runner for synthetic QA. Test the bundled advertising-free site or configure your
own target. Event collection and artifact downloads always use the local receiver.

## Setup on Windows

Requires Python 3.10+ and Node.js 20+. From the repository directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

Setup creates `.venv`, installs the pinned Python and Node dependencies, installs
**Firefox and WebKit**, and verifies actual pages in desktop, iPhone and iPad
contexts. Desktop/Android reuse installed Chrome, then Edge, then bundled Chromium.
If none launches, setup downloads Chromium. To install Chromium explicitly too:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -DownloadChromium
```

Manual equivalent:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --timeout 120 -r requirements-dev.txt
npm.cmd ci
npx.cmd playwright install firefox webkit
# Optional if installed Chrome/Edge work; required otherwise:
npx.cmd playwright install chromium
npm.cmd run browser:check
```

After changing Playwright versions, rerun browser installation. On Linux, use
`npx playwright install --with-deps chromium firefox webkit` for OS dependencies.
The Python server needs only the standard library; the runner uses Node Playwright.
Python Playwright is optional for additional automation, and has its own pinned version.

## Start and run

Terminal 1:

```powershell
cd D:\Ad_Traffic\my_app
npm.cmd start
```

Terminal 2:

```powershell
cd D:\Ad_Traffic\my_app
npm.cmd run browser:lab
```

Open **http://127.0.0.1:8765/lab/dashboard**. It refreshes every two seconds and
shows event totals, recent events, run results, performance details, screenshots,
retained trace downloads and JSON reports. Errors are shown while the receiver is
unavailable; refreshing resumes when it returns. Stop the receiver with Ctrl+C.

The default run has four profiles and four journeys: 15 executed sessions and one
explicit desktop/mobile-menu skip. Each journey uses isolated contexts. Up to eight
profiles (including repeats), 64 matrix entries and eight concurrent sessions are
allowed; concurrency defaults to four. A repeated profile gets a fresh identity.

| Profile | Automatic engine | Emulation |
| --- | --- | --- |
| desktop | installed Chrome/Edge, or Chromium | 1440 x 900 |
| android | installed Chrome/Edge, or Chromium | Pixel 7 |
| iphone | WebKit | iPhone 13 |
| tablet | WebKit | iPad Mini |

Firefox is supported for desktop. Explicit Chromium-family browsers cannot be used
for iPhone/iPad; those profiles always require WebKit. WebKit tests the engine and
device emulation, rather than physical Apple hardware or the shipping Safari app.

```powershell
# Original eight-event journey on each profile:
npm.cmd run browser:lab -- --journeys browse
# Firefox desktop, including history and returning sessions:
npm.cmd run browser:lab -- --profiles desktop --browser firefox
# Choose subsets or repeated independent sessions:
npm.cmd run browser:lab -- --profiles android,iphone,android --journeys history,mobile-menu
npm.cmd run browser:lab -- --profiles desktop --browser msedge --headed
node browser_lab.cjs --help
```

| Journey | Checks |
| --- | --- |
| browse | Landing page, mock player play/pause, Shows/Trending/Videos, scrolling, viewport fit and screenshot; eight events |
| history | Link navigation, back, forward, reload and expected URLs |
| mobile-menu | Initial hidden state, open/close, navigation and collapsed state after navigation; desktop is skipped |
| returning | First visit saves cookies/local storage; a new context restores them and verifies fresh session storage |
| smoke | Load a configurable target, viewport fit, scroll and screenshot; three events |

Returning-session state stays in memory and is scoped to one journey. Separate
virtual identities never share it. This checks browser storage persistence, not
an application's account/login flow.

## Configure another target

Keep the receiver running. A URL uses the generic `smoke` journey by default:

```powershell
npm.cmd run browser:lab -- --target http://127.0.0.1:9000/ --profiles desktop,iphone
npm.cmd run browser:lab -- --target https://staging.example.com/ --profiles desktop --journeys smoke,returning
```

For site-specific journeys, copy and edit [targets/example.json](targets/example.json),
then explicitly select the journeys to run:

```powershell
npm.cmd run browser:lab -- --config targets\example.json --journeys browse,history,mobile-menu,returning
```

`baseURL` is required in the JSON file. `routes` resolve against it; `selectors`
are Playwright CSS selectors. The example matches the bundled site's structure;
replace its selectors and routes to match your staging app. `browse` expects
Playing/Stopped text and the player's `aria-pressed` state. `mobile-menu` expects
an `aria-expanded` toggle and navigation links matching the Shows path. Custom
targets default to `smoke`, even if their JSON defines additional selectors.

The target origin is automatically allowed; list any additional asset/API origins
in `allowedOrigins`, for example `https://assets.example.com`. Origins must be
HTTP(S), with no path, query or credentials. Use the final target URL if your
entry URL redirects. Configured route origins must be in the allow list.
Service workers and WebSockets are blocked. Events are posted by the runner to
the receiver, so the target does not need `/lab/event`, receiver CORS access or
the bundled site's badge. The receiver and dashboard continue to bind only to
`127.0.0.1`. `observed_ip` describes the receiver's telemetry connection.

## Network profiles

```powershell
npm.cmd run browser:lab -- --profiles desktop,iphone --journeys smoke --networks native,fast-4g,slow-3g,offline
```

| Profile | Latency | Download | Upload |
| --- | --- | --- | --- |
| native | unchanged | unchanged | unchanged |
| fast-4g | 40 ms | 9 Mbps | 3 Mbps |
| slow-3g | 400 ms | 400 Kbps | 400 Kbps |
| offline | first navigation blocked, then online recovery | — | — |

Chromium uses CDP network emulation. Firefox/WebKit approximate latency and
upload/download transfer time using a delay per intercepted response; this buffers
responses and does **not** impose a shared bandwidth limit or simulate streaming,
packet loss, CPU speed or a physical connection. The method and requested values
are recorded under each session's `network`. Offline verifies navigation fails,
then restores online mode and runs the selected journey, including returning visits.
Routing disables the browser HTTP cache, including in returning sessions. Receiver
telemetry and dashboard capture are outside the target's network profile.

Use `--concurrency 1` for less timing interference and `--timeout 60000` for slow
targets. Timeouts are milliseconds, from 100 to 120000.

## Performance reports

`summary.json` contains actual engine/version, device observations, actions,
`transitions` and per-document `documents`. Transitions measure wall time through
the expected URL, load event, configured ready selector and two animation frames.
Documents contain Navigation Timing (TTFB, DOMContentLoaded, load, duration,
redirect timing and transfer bytes) and **LCP, CLS and INP** collected with the
pinned [Google web-vitals library](https://github.com/GoogleChrome/web-vitals).
LCP/INP are milliseconds; CLS is unitless. Page-hide flushes finalize each page.

Each vital has `value`, `status`, and, when measured, `rating`. Unsupported APIs
are `unsupported` with a null value; supported APIs without a sample are `no-data`
with a null value. A smoke page with no measured interactions can have no INP.
These are short synthetic lab samples, with tracing and concurrent sessions
affecting timings, rather than field percentiles or a Core Web Vitals compliance
assessment. The dashboard shows the latest measured value per vital per session;
the JSON retains the individual document results.

## Traces and artifacts

Default `--trace retain-on-failure` records browser operations, DOM snapshots,
network activity and screenshots, then keeps ZIPs only for failed journeys and
failed dashboard capture. Returning journeys can produce two traces. Successful
captures are discarded after cleanup. `on` retains successes too; `off` records none:

```powershell
npm.cmd run browser:lab -- --trace on
npm.cmd run browser:lab -- --trace off
npx.cmd playwright show-trace "artifacts\RUN-DIRECTORY\SESSION-trace.zip"
```

Use the real path in `summary.json` or download a trace from the dashboard. The
[local Trace Viewer](https://playwright.dev/docs/trace-viewer) loads the Playwright
ZIP directly; no unzip or conversion is needed. These library-level traces include
browser actions, rather than Node assertions. They can contain page/request data.
Retained ZIPs stay on disk until manually removed; there is no age/size pruning.

- `artifacts/events.jsonl`: append-only event history, restored on receiver restart.
- `artifacts/<timestamp>-<unique suffix>/summary.json`: completed run and report snapshot.
- Run directory `*.png`: session/failure/dashboard screenshots.
- Run directory `*-trace.zip`: retained traces; `traces` lists all traces per session.
- Optional `artifacts/report.json`: exported receiver report.

The dashboard lists the latest 20 completed runs and links only existing artifacts.
Reports and event totals cover the latest 5000 events; the disk log keeps older
events. Use `npm.cmd start -- --no-persist` for empty in-memory event history, or
`--event-log PATH` for a separate event log. Corrupt/incomplete event records are
skipped with a warning. Artifact storage is ignored by Git.

Custom output directories must also be configured on the receiver to get dashboard
download links:

```powershell
npm.cmd start -- --artifacts-dir D:\LabResults
npm.cmd run browser:lab -- --output D:\LabResults
```

If port 8765 is busy, use `npm.cmd start -- --port 8766` and pass `--port 8766` to
browser, simulate and report commands. This changes the receiver port; a separately
configured target URL stays independent.

## Request simulator and tests

The request-only simulator remains local and does not launch browsers:

```powershell
npm.cmd run simulate -- --devices android,ios,desktop,tablet --count 5 --interval 0.2
npm.cmd run report -- --output artifacts\report.json
npm.cmd test
# Individual suites:
npm.cmd run test:python
npm.cmd run test:browser
```

Tests create their own receivers on free ports. Install all engines first; a
missing browser causes a failure rather than silently skipping its coverage.
Coverage includes the original player/layout/event checks plus real WebKit/Firefox,
all journeys, network profiles and offline recovery, independent targets, timing
and vitals, trace retention modes, byte-identical ZIP downloads, and loading traces
in the shipped Trace Viewer. Receiver tests cover validation, persistence,
retention, restart recovery, report exports and artifact traversal rejection.
Test artifacts are preserved under `artifacts/`; receivers and browsers are closed.

On Linux/macOS use `python3 -m venv .venv`, `.venv/bin/python`, and `npm`/`npx`.
The npm Python launcher automatically uses the repository virtual environment;
`LAB_PYTHON` can override it. `claimed_device` is an emulated profile, not evidence
of physical hardware or a unique person.
