# Classroom CO2 display: project notes for Claude Code

Goal: show the CO2 level of a classroom on a repurposed Framio digital picture frame
(Tikvito S580: Android 6.0.1, 1280x800, 1 GB RAM, 2.4 GHz Wi-Fi only).

Data path: K30 sensor -> Particle Photon -> Particle Cloud (`co2` event, once a minute)
-> Particle webhook -> Cloudflare Worker (this folder) -> display page in a kiosk browser on the frame.

## Hardware (working)
- Sensor: Senseair K30 FR (art. no. 030-8-0010), I2C address 0x68. Datasheet: PSP0109 rev 9.
- Read command: write `22 00 08 2A`, wait ~20 ms, read 4 bytes `status, hi, lo, checksum`.
  Valid if `status & 1` and `checksum == (status + hi + lo) & 0xFF`. ppm = hi*256 + lo.
  (This I2C protocol is not in the datasheet; it is the commonly used one and it works on this sensor.)
- Wiring: K30 SDA -> Photon D0, SCL -> D1, K30 G0 -> Photon GND (common ground).
  K30 G+ must come from its own regulated 5 V supply (4.5-14 V, ~600 mA peaks), not the Photon's 3V3.
  The K30's I2C lines are 3.3 V with on-board pull-ups. Do not put a 5 V Arduino on them.
- ABC (self-calibration) is off on this part. Manual calibration: short the Din1 holes for 8 s in fresh air.
- Photon firmware: `firmware/k30_publish.ino` (v2). Reads every 2 s, publishes the latest GOOD ppm every 60 s,
  exposes `co2`, `co2age` and `status` cloud variables. One of the user's Photons is dead (stuck on a solid D7 LED).
- Known problem (reported 2026-10-26): in v1 the sensor worked for about an hour, then the same number repeated.
  v1 kept re-publishing the last good value after reads started failing, which hid the failure (the Worker stamps
  rows with its own arrival time, so a stale value still looks fresh). v2 stops publishing after 30 s without a good
  read, treats 150 identical reads as frozen, and recovers: Wire.reset() -> optional K30 power cycle -> reboot.
  Diagnostic events are `k30err` / `k30info`. They must not start with "co2", because the Particle webhook matches
  event names by prefix and the Worker rejects non-numeric data.
  Root cause not yet known: could be the K30 locking up the I2C bus, K30 power sag, or the K30 returning a frozen value.
  A Particle forum thread reports that Wire.reset() did not free a slave holding SCL low and only cutting the
  sensor's power did, so a relay/MOSFET on K30 G+ (K30_POWER_PIN) may be needed.
- v2 was only compiled and simulated against a host stub, not on a real Photon or Device OS.
- 2026-10-26 log from the user's Particle console: co2 events kept their exact :11 cadence through a
  "k30err bus reset after no reply" at 1:32:51 pm, with no boot event, so the Photon did not reboot and the
  K30 answered again within ~20 s after Wire.reset(). The user says this repeats about every 10 published readings
  (~10 min). Earlier the user saw reset reason 40 (power-down) boots; the capacitor was added since.
  v2.1 adds the failure reason (write error N / short read / not ready / bad checksum) to the k30err text.

## This folder
- `src/index.js`: Worker. `POST /api/ingest` (needs `X-Webhook-Secret`), `GET /api/latest`, `GET /api/history?hours=24`.
- `public/index.html`: display page. Must stay ES5 with XMLHttpRequest and canvas (Android 6 WebView).
  No CSS variables, grid, arrow functions, let/const, fetch, or template literals.
- `schema.sql`, `wrangler.toml`, `README.md` (setup steps and the Particle webhook fields).
- Decisions: D1 not KV (KV free plan allows 1,000 writes/day; one reading a minute is ~1,440).
  Clock labels are rendered server-side in `TIMEZONE` (America/Denver) because the frame's clock is set to America/Phoenix.

## Network constraints (school network)
- `*.workers.dev` is blocked at school. The Worker is therefore routed to `co2.fittheline.com`
  (fittheline.com is in the user's Cloudflare account and loads at school).
- Node on the school network fails TLS with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (looks like HTTPS inspection),
  so `npx wrangler login` and deploys failed there. Run Wrangler from home Wi-Fi or a phone hotspot.
  `set NODE_OPTIONS=--use-system-ca` (Node 22.15+) may help at school but is untested.
  Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Status
Done and tested: sensor reads over I2C on a Photon; Photon publishes to the Particle console;
the Worker and page were tested locally with `wrangler dev`, fake data, and jsdom. Deployed and
confirmed working end to end since 2026-10-23: `co2.fittheline.com`, D1, `INGEST_SECRET`, Particle
webhook, and the frame are all live.
Not done: ADB/kiosk browser setup on the frame is still flaky (see Hardware section);
root cause of the K30 I2C stalls is unconfirmed; the room-name query param was removed entirely
(not just unused) on 2026-10-27.

## D1 usage incident (2026-10-27)
The account hit 78% of the free-tier 5,000,000 rows_read/day cap. Root cause: `/api/history` was
reading the whole requested window from D1 on every call (no edge caching), and worse, the display
page's `get()` helper appended a cache-busting `?_=<timestamp>` to every XHR, including
`/api/history` — so even after a same-session fix added Cloudflare edge caching (`cachedHistory()`
using `caches.default`, 5 min) and a single-pass peak calculation (`MAX(ppm)` in the same query
instead of a second `SELECT ... ORDER BY ppm DESC LIMIT 1`), the cache key never matched twice and
every open page kept re-reading the full window directly from D1 every `HISTORY_EVERY_MS` (5 min).
Fixed by removing the cache-buster from `get()` in `public/index.html` (`src/index.js` already had
the single-pass query + edge cache from an earlier, undeployed edit) and deploying. Verified live:
a second `/api/history?hours=24` request now returns `CF-Cache-Status: HIT`, so all open pages
share one D1 read per 5-minute window instead of each paying for their own.
**How to apply:** never add a cache-busting query param to a request the Worker is meant to cache
at the edge; `/api/latest` already disables caching itself via `Cache-Control: no-store`, so it
doesn't need one either. If D1 usage climbs again, check Cloudflare dashboard D1 → classroom-co2 →
Metrics, and check `CF-Cache-Status` on `/api/history` first.
