# Synthetic Device Traffic Lab

Small Python standard-library lab for observing how **claimed device identities** and
**observed network IP addresses** differ. It generates synthetic events only; it
does **not** visit a website, execute JavaScript, load an ad tag, or produce ad impressions.

## Quick start

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

## Tests

```bash
python3 -m unittest discover -s tests -v
```
