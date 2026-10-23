# RIENG Synthetic Device & Browser Lab

Small Python standard-library lab for observing how **claimed device identities** and
**observed network IP addresses** differ. It generates synthetic events only; it
does **not** visit a website, execute JavaScript, load an ad tag, or produce ad impressions.

## Quick start: local synthetic requests

Python 3.10+ is required. No packages need installing.

Open terminal 1:

```bash
python3 lab.py serve
```

In terminal 2:

```bash
python3 lab.py simulate --devices android,ios,desktop,tablet --count 5 --interval 2
```

You can repeat a device type to simulate multiple virtual devices:

```bash
python3 lab.py simulate --devices android,android,ios --count 3 --interval 1
```

Review results:

```bash
python3 lab.py report
```

## What to observe

- `claimed_device`: A **synthetic label**, not proof of an actual device.
- `reported_user_agent`: A deliberately marked **LabSimulator** identifier.
- `observed_ip`: The receiver's actual connection peer IP. On this localhost-only
  receiver, all requests will normally show `127.0.0.1`.
- `total_events`: Synthetic lab events, **not** ad impressions.

The client supports up to 12 virtual devices and at most 100 events per device.
Its destination is **hardcoded to loopback (`127.0.0.1`)**; it cannot target
Rieng Radio, `ftd.agency`, or any real ad network. This keeps testing separate
from campaign accounting and prevents accidental invalid impressions.

## Advanced browser lab (Chromium)

The upgraded lab drives actual Chromium browser contexts through an entirely
**local, advertising-free staging page**. It checks responsive layouts and mock
player controls, navigates across Shows and Trending, scrolls, and captures
screenshots for desktop, Android-sized, iPhone-sized and tablet-sized profiles.
These profiles approximate device characteristics; they aren't physical devices.

First install the Node dependencies and Chromium once:

```bash
npm install
npx playwright install chromium
```

Chromium must be downloaded separately; if the download fails on your machine,
the Python synthetic-request lab and dashboard still work independently.

Keep `python3 lab.py serve` running in one terminal. In another terminal:

```bash
npm run browser:lab
```

Select one or more profiles (up to eight simultaneous isolated browser contexts):

```bash
node browser_lab.cjs --profiles android,iphone,desktop,android
```

Open **http://127.0.0.1:8765/lab/dashboard** to see totals by claimed device
and action, unique observed IPs, and the latest events. Browser screenshots and
JSON summaries are saved locally under `artifacts/` (ignored by Git).

The browser runner **hardcodes the localhost target** and blocks network
requests to external hosts. It does not connect to `www.riengradio.co.ke`,
load the Catfish advertising tag, spoof unique people, or produce ad impressions.
The action script is fixed and repeatable; it is for QA and analysis, not for
camouflaging paid advertising traffic.

## Tests

```bash
python3 -m unittest discover -s tests -v
```
